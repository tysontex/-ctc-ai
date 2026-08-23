# CTC AI, one-package deployment

This package contains the CTC AI front end and secure Node/Express backend.

## Deploy on Render

1. Put this folder in a GitHub repository.
2. In Render choose New -> Web Service and connect the repository.
3. Runtime: Node.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add an environment variable:
   `OPENAI_API_KEY` = your OpenAI API key
7. Optional:
   `CTC_LOCATION` = `Perth, Western Australia`
8. Deploy.

The browser app and API are served from the same service, so the HTML can call `/api/research` and `/api/candidate-question` without changing the front-end URL.

## Important security rule

Never put the OpenAI key in `public/index.html`, GitHub, or a mobile app. Keep it only in the hosting provider's environment variables.

## Test

After deployment, open:
`https://YOUR-RENDER-URL.onrender.com/api/health`

It should show:
`"openaiConfigured": true`

Then open the normal Render URL and press `Refresh research`.

The researcher uses the OpenAI Responses API with web search. The first version stores candidates in a local JSON file. For a real multi-device production app, replace that with a managed database and add scheduled jobs.
