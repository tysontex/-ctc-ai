import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LOCATION = process.env.CTC_LOCATION || "Perth, Western Australia";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(ROOT, "ctc-data.json");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

function openaiClient() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function loadDb() {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, "utf8"));
  } catch {
    return { tilers: [], builders: [], updatedAt: null };
  }
}

async function saveDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function jsonFromModel(text) {
  const clean = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("AI returned an invalid JSON response.");
  }
  return JSON.parse(clean.slice(start, end + 1));
}

async function webResearch(prompt) {
  const client = openaiClient();

  const response = await client.responses.create({
    model: "gpt-5",
    tools: [{ type: "web_search" }],
    input: prompt
  });

  return response.output_text;
}

/* Health check */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    location: LOCATION
  });
});

/* Return stored candidates */
app.get("/api/candidates/:type", async (req, res) => {
  try {
    const type = req.params.type === "builders" ? "builders" : "tilers";
    const db = await loadDb();

    const candidates = Array.isArray(db[type]) ? db[type] : [];

    res.json({
      candidates: candidates
        .slice()
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, 50),
      updatedAt: db.updatedAt || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not load candidates." });
  }
});

/* Ask AI about one candidate */
app.post("/api/candidate-question", async (req, res) => {
  try {
    const { question, candidate, type } = req.body || {};

    if (!question || !candidate) {
      return res.status(400).json({
        error: "question and candidate are required."
      });
    }

    const prompt = `You are CTC AI, a recruitment research assistant for a tiling business in Perth, Western Australia.

Answer the user's question about ONE candidate.

Use the candidate information below and, when useful, search the public web to verify or expand the information.

Be specific and useful. Do not give vague generic statements.
Use actual details such as experience, skills, project types, location, qualifications, business history, public reviews or other relevant evidence.
Never invent facts.
If something cannot be confirmed, say that it is not confirmed.
Clearly distinguish verified evidence, candidate/business claims and AI inference.
Do not infer sensitive personal characteristics from photographs or other indirect information.

Candidate type:
${type}

Candidate:
${JSON.stringify(candidate, null, 2)}

User question:
${question}

Return a concise answer of 2-5 sentences.`;

    const answer = await webResearch(prompt);

    res.json({ answer });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Candidate AI request failed."
    });
  }
});

/* Run live tiler/builder research */
app.post("/api/research", async (req, res) => {
  try {
    const type = req.body?.type === "builders" ? "builders" : "tilers";
    const limit = Math.min(
      Math.max(Number(req.body?.limit || 10), 1),
      10
    );

    const role =
      type === "tilers"
        ? "professional tilers and tiling subcontractors"
        : "residential builders, renovation builders and construction companies";

    const prompt = `You are CTC AI's live lead-discovery researcher.

Find up to ${limit} promising ${role} in ${LOCATION}.

The goal is to find REAL businesses or professionals who could realistically become useful to a Perth tiling business.

FOR TILERS:
Prioritise:
- relevant tiling experience
- bathrooms and residential floors
- waterproofing
- large-format tiling
- mosaics and stone
- ability to work independently
- own tools/vehicle where publicly evidenced
- location and travel suitability
- evidence of professional reliability
- evidence they may accept subcontract or additional work

FOR BUILDERS:
Prioritise:
- current or recent residential projects
- bathroom and renovation work
- custom homes
- evidence of an active project pipeline
- evidence of using subcontractors
- location
- businesses that could realistically generate recurring tiling work

RESEARCH RULES:
- Search the public web.
- Prefer official business websites, professional profiles, project pages, reputable directories and independent review sources.
- Investigate each candidate individually.
- Cross-check important claims across sources where possible.
- Do NOT invent names, experience, services, projects, reviews, contact details, photos, availability or qualifications.
- If evidence is missing, state that it is unconfirmed rather than guessing.
- Do not infer sensitive personal characteristics.
- Only identify an individual by name when the public source clearly identifies them professionally.
- Do not use a generic placeholder such as "Daniel M.".
- Do not return fictional businesses such as "Westline Renovations" unless a real public source supports that exact business.
- Return real public source URLs supporting the candidate.

For every candidate return:
name
meta
score from 0-100
initials
tags
metrics
why
evidence
confidence
sourceUrls
workPhoto
facePhoto
workPhotos

Score candidates according to CTC fit, not popularity.

Return ONLY valid JSON in exactly this structure:
{
  "candidates": [
    {
      "name": "Real public name or business name",
      "meta": "Role · suburb/area · relevant experience",
      "score": 0,
      "initials": "AB",
      "tags": ["..."],
      "metrics": [
        ["Experience", "..."],
        ["Distance", "..."],
        ["Fit", "..."]
      ],
      "why": "Specific explanation using researched facts.",
      "evidence": "Specific evidence and source-backed findings.",
      "confidence": "High, Medium or Low, with a brief reason.",
      "sourceUrls": ["https://..."],
      "workPhoto": "",
      "facePhoto": "",
      "workPhotos": []
    }
  ]
}`;

    const raw = await webResearch(prompt);
    const parsed = jsonFromModel(raw);
    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
      : [];

    const db = await loadDb();
    if (!Array.isArray(db[type])) db[type] = [];

    for (const candidate of candidates) {
      if (!candidate?.name) continue;

      const existing = db[type].find(
        item =>
          String(item.name).trim().toLowerCase() ===
          String(candidate.name).trim().toLowerCase()
      );

      const timestamp = new Date().toISOString();

      if (existing) {
        Object.assign(existing, candidate, {
          lastResearchedAt: timestamp
        });
      } else {
        db[type].push({
          ...candidate,
          firstSeenAt: timestamp,
          lastResearchedAt: timestamp
        });
      }
    }

    db[type].sort(
      (a, b) => Number(b.score || 0) - Number(a.score || 0)
    );

    db.updatedAt = new Date().toISOString();
    await saveDb(db);

    res.json({
      candidates: db[type].slice(0, 10),
      updatedAt: db.updatedAt
    });
  } catch (error) {
    console.error("CTC research error:", error);

    res.status(error.status || 500).json({
      error: error.message || "Live research failed."
    });
  }
});

/* Serve the CTC frontend */
app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

/* Express 5 compatible fallback */
app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    !req.path.startsWith("/api/")
  ) {
    return res.sendFile(path.join(ROOT, "public", "index.html"));
  }

  res.status(404).json({ error: "Not found." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CTC AI backend listening on port ${PORT}`);
});
