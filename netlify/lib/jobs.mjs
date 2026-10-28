import { E, now, getJob, setJob } from "./db.mjs";
import * as core from "./core.mjs";

// Long work (LLM calls, web fetching, sending) runs in a Netlify Background Function (up to 15 minutes, free).
// The browser starts a job and polls its status.
const RUNNERS = {
  research: async (p) => { await core.research(p.id); return { summary: "Research done." }; },
  score: async (p) => { const r = await core.scoreLead(p.id); return { summary: `Score: ${r.score}/100` }; },
  draft: async (p) => { await core.draft(p.id); return { summary: "Emails written. Open the Review tab." }; },
  autopilot: async (p, pr) => {
    const r = await core.autopilot(p, pr);
    return { summary: `Scored ${r.scored}, wrote emails for ${r.drafted} (minimum score ${r.threshold}).` + (r.failed ? ` ${r.failed} failed.` : "") };
  },
  discover: (p, pr) => core.discover(p, pr),
  send: (p, pr) => core.sendDue(pr),
  crm: (p, pr) => core.crmSync(pr),
  inbox: (p, pr) => core.checkInbox(pr),
  paste: (p) => core.pasteReply(p.id, p.text),
  pipeline: (p, pr) => core.runPipeline(p, pr),
};

export const jobSecret = () => E("JOB_SECRET") || E("APP_PASSWORD");

export async function startJob(origin, type, params = {}) {
  if (!RUNNERS[type]) return { error: "Unknown job: " + type };
  const cur = await getJob();
  if (["queued", "running"].includes(cur.status) && Date.now() - Date.parse(cur.updated || 0) < 20 * 60000)
    return { error: `Another job is still running (${cur.type}). Wait for it to finish.` };
  await setJob({ type, status: "queued", progress: "Starting...", started: now(), updated: now() });
  const r = await fetch(`${origin}/.netlify/functions/job-background`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-job-secret": jobSecret() }, body: JSON.stringify({ type, params }),
  });
  if (r.status >= 300) { await setJob({ type, status: "error", error: `Could not start background job (${r.status}).`, updated: now() }); return { error: `Could not start background job (${r.status}).` }; }
  return { ok: 1 };
}

export async function runJob(type, params = {}) {
  const started = now();
  const progress = async (msg) => setJob({ type, status: "running", progress: msg, started, updated: now() });
  await progress("Working...");
  try {
    const r = (await RUNNERS[type](params, progress)) || {};
    if (r.error) await setJob({ type, status: "error", error: r.error, started, updated: now() });
    else await setJob({ type, status: "done", summary: r.summary || "Done.", started, updated: now() });
  } catch (e) {
    await setJob({ type, status: "error", error: String(e.message || e), started, updated: now() });
  }
}
