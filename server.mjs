import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const LOCATION = process.env.CTC_LOCATION || "Perth, Western Australia";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(ROOT, "ctc-data.json");

app.use(express.static(path.join(ROOT, "public")));

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error("OPENAI_API_KEY is not configured.");
    e.status = 500;
    throw e;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function loadDb() {
  try { return JSON.parse(await fs.readFile(DB_FILE, "utf8")); }
  catch { return { tilers: [], builders: [], updatedAt: null }; }
}

async function saveDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function parseJson(text) {
  const s = String(text || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Researcher did not return valid JSON.");
  return JSON.parse(s.slice(a, b + 1));
}

async function runAI(client, input) {
  const r = await client.responses.create({
    model: "gpt-5",
    tools: [{ type: "web_search" }],
    input
  });
  return r.output_text;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, openaiConfigured: Boolean(process.env.OPENAI_API_KEY), location: LOCATION });
});

app.post("/api/candidate-question", async (req, res) => {
  try {
    const client = getClient();
    const { question, candidate, type } = req.body || {};
    if (!question || !candidate) return res.status(400).json({ error: "question and candidate are required" });

    const input = `You are CTC AI, a recruitment research assistant for a Perth tiling business.
Answer the user's question about this one candidate.
Use actual details from the supplied profile and web-search when needed.
Be concise and specific. Never invent facts. If something is not established, say it is not confirmed.
Distinguish verified evidence, candidate claims and AI inference.
Do not infer sensitive traits from appearance.

Candidate type: ${type}
Candidate:
${JSON.stringify(candidate, null, 2)}

Question:
${question}

Return 2-5 sharp sentences.`;

    res.json({ answer: await runAI(client, input) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "AI request failed" });
  }
});

app.post("/api/research", async (req, res) => {
  try {
    const client = getClient();
    const type = req.body?.type === "builders" ? "builders" : "tilers";
    const limit = Math.min(Math.max(Number(req.body?.limit || 10), 1), 10);
    const role = type === "tilers" ? "tilers and tiling subcontractors" : "residential builders and renovation builders";

    const input = `You are CTC AI's live lead-discovery researcher.
Find up to ${limit} promising ${role} in ${LOCATION}.

For tilers, prioritise relevant experience, technical skills, independent-work signals, location and evidence of professional reliability.
For builders, prioritise current/upcoming projects, renovation/bathroom work, likely subcontracting opportunities, location and evidence of an ongoing project pipeline.

Use public web sources and investigate candidates individually. Prefer professional/business websites, public business profiles, project pages, reputable directories and independent review sources.
Do not invent names, experience, services, projects, reviews, contact details, photos or availability.
A lack of evidence is not a negative finding.
Do not infer sensitive characteristics.
Only include a public professional person's name when the source clearly identifies them professionally.

Return ONLY JSON:
{"candidates":[
{"name":"...","meta":"...","score":0,"initials":"...","tags":[],"metrics":[["Experience","..."],["Distance","..."],["Fit","..."]],"why":"...","evidence":"...","confidence":"...","sourceUrls":[],"workPhoto":"","facePhoto":"","workPhotos":[]}
]}`;

    const parsed = parseJson(await runAI(client, input));
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const db = await loadDb();

    for (const c of candidates) {
      if (!c?.name) continue;
      const old = db[type].find(x => x.name.toLowerCase() === c.name.toLowerCase());
      if (old) Object.assign(old, c, { lastResearchedAt: new Date().toISOString() });
      else db[type].push({ ...c, firstSeenAt: new Date().toISOString(), lastResearchedAt: new Date().toISOString() });
    }

    db[type].sort((a,b) => (b.score || 0) - (a.score || 0));
    db.updatedAt = new Date().toISOString();
    await saveDb(db);
    res.json({ candidates: db[type].slice(0, 10), updatedAt: db.updatedAt });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Research failed" });
  }
});

app.get("/api/candidates/:type", async (req, res) => {
  const type = req.params.type === "builders" ? "builders" : "tilers";
  const db = await loadDb();
  res.json({ candidates: db[type].slice().sort((a,b) => (b.score || 0) - (a.score || 0)).slice(0, 50) });
});

app.get("/{*splat}", (req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => console.log(`CTC AI listening on ${PORT}`));
