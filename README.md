# AI SDR (free, runs on Netlify)

Researches leads, writes outreach, sends it after your approval, and sorts replies. It does not book calls;
interested replies are flagged for you. Same features as the original app, now hosted for free on Netlify.

## Deploy (about 10 minutes, all free)
Netlify Drop (drag and drop) does not build functions, so use GitHub or the CLI.

**Option A: GitHub**
1. Push this folder to a new GitHub repo.
2. Netlify > Add new site > Import from Git > pick the repo. No build command needed; settings come from `netlify.toml`.
3. Site configuration > Environment variables: add `APP_PASSWORD`, `GEMINI_API_KEY`, `MAIL_USER`, and `MAIL_PASS` (plus `SMTP_HOST`/`SMTP_PORT` if your provider is not Gmail).
4. Deploy, open the site, sign in with `APP_PASSWORD`.

**Option B: CLI**
```
npm i -g netlify-cli
npm install
netlify login
netlify init        # or: netlify link
netlify env:import .env   # after copying .env.example to .env and filling it in
netlify deploy --prod
```
Try it locally first with `netlify dev`.

## What changed from the Python version (and why)
- **AI model:** Netlify cannot reach Ollama on your computer, so the free default is the Google Gemini free tier
  (get a key at aistudio.google.com/apikey). Groq and OpenRouter free tiers also work, and Claude is still supported
  (`ANTHROPIC_API_KEY`). Ollama works only if your server has a public URL (`OLLAMA_URL`). The app picks whichever
  key you set, or force one with `LLM_BACKEND`. Free tiers are rate limited; the app retries automatically.
- **Database:** SQLite is replaced by Netlify Blobs (free, built in). Nothing to set up.
- **Long tasks:** research, scoring, writing, discovery, sending, inbox checks and the pipeline run as Netlify
  Background Functions (up to 15 minutes). The page shows live progress.
- **AUTO_RUN:** now a Netlify Scheduled Function that runs hourly on the published site when `AUTO_RUN=1`.
- **Password:** because the site is public and can send email, every request needs `APP_PASSWORD`. Required.
- **Pipeline** also reads your inbox first (when `MAIL_USER` is set) so replied leads never get a follow-up.
- **New in the UI:** a "Paste a reply" box on the Replies tab (the original only had this as an API endpoint).

## Costs and limits
- Free: Netlify free plan, Netlify Blobs, and the free AI tiers. Check each provider's current limits.
- Leads come from the free web search, a CSV (name,email,title,company,domain), or Apollo if you have a key.
- Email: your provider is the real limit (Gmail roughly 500/day, less for new accounts). Sending too fast gets you
  flagged as spam, so warm up the domain and ramp gradually. Use `DAILY_SEND_CAP`.
- Draft-only mode (`MAIL_USER` blank): copy each email, send it yourself, tap Mark as sent.
- The Setup tab includes **Verify mailbox connection**. SMTP credentials are read only from Netlify environment variables and are never saved in lead records. For Gmail or Google Workspace, use an app password or provider-approved SMTP credential; do not use your normal account password.
- Web discovery scrapes search pages from Netlify's servers; if the search engines block it you will get fewer
  results. A CSV upload always works. CSV uploads are limited to about 6 MB.
- Follow CAN-SPAM/GDPR: honest sender info, opt-out honored (built in).

## Lead scoring
Each lead gets 0-100: rules (0-50) for seniority, title match, company size, and business email, plus an AI fit
rating (0-50) comparing the company's website to your ICP. Set target titles, employee range, and a minimum score
in Setup. "Score and write top 10" skips everything below the minimum. Optional CSV columns: employees, industry.

## Full pipeline
Find leads (free web search, CSV, or Apollo) -> score -> personalised 3-email sequence -> optional auto-approve ->
sync to HubSpot (or export CSV for any CRM) -> send -> follow up after FOLLOWUP_DAYS only if there is no reply.
A reply, unsubscribe, or wrong-person answer stops the sequence. Interested leads are flagged for you to book the
discovery call. "Run full pipeline" does it all once; AUTO_RUN=1 repeats it hourly. The Insights tab shows reply
rates by score, seniority, company size, and which email got the reply.
