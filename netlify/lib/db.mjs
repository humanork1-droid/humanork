import crypto from "node:crypto";

export const E = (k, d = "") => process.env[k] || d;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toint = (v) => {
  const s = String(v ?? "").replace(/,/g, "").trim();
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
};
export const now = () => new Date().toISOString();

// Storage: Netlify Blobs (free, built in). One blob per lead (with its drafts and messages),
// plus small blobs for settings, suppression list and the current background job.
let _store;
async function store() {
  if (globalThis.__SDR_STORE__) return globalThis.__SDR_STORE__; // test hook
  if (!_store) {
    const { getStore } = await import("@netlify/blobs");
    _store = getStore({ name: "ai-sdr", consistency: "strong" });
  }
  return _store;
}

export const hid = (email) => crypto.createHash("sha1").update(email.toLowerCase()).digest("hex").slice(0, 12);
export const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();
export const normalizeDomain = (domain) => String(domain ?? "").trim().toLowerCase()
  .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
export const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const CFG = ["icp", "titles", "min_emp", "max_emp", "threshold"];

export async function getSettings() {
  const s = await store();
  return (await s.get("settings", { type: "json" })) || {};
}
export async function saveSettings(o) {
  const s = await store();
  await s.setJSON("settings", o);
}

export async function getLead(id) {
  const s = await store();
  return await s.get("lead/" + id, { type: "json" });
}
export async function putLead(l) {
  const s = await store();
  await s.setJSON("lead/" + l.id, l);
}
// Read-modify-write one lead. Always re-reads right before writing so long LLM calls never clobber newer edits.
export async function updateLead(id, fn) {
  const l = await getLead(id);
  if (!l) return null;
  await fn(l);
  await putLead(l);
  return l;
}
export async function allLeads() {
  const s = await store();
  const { blobs } = await s.list({ prefix: "lead/" });
  const out = [];
  for (let i = 0; i < blobs.length; i += 20) {
    const chunk = await Promise.all(blobs.slice(i, i + 20).map((b) => s.get(b.key, { type: "json" })));
    out.push(...chunk.filter(Boolean));
  }
  return out;
}

export async function getSuppression() {
  const s = await store();
  return new Set((await s.get("suppression", { type: "json" })) || []);
}
export async function addSuppression(email) {
  const s = await store();
  const set = new Set((await s.get("suppression", { type: "json" })) || []);
  set.add(email.toLowerCase());
  await s.setJSON("suppression", [...set]);
}

export async function addLead(sup, f) {
  const email = normalizeEmail(f.email);
  if (!validEmail(email) || sup.has(email)) return 0;
  const id = hid(email);
  const s = await store();
  if (await s.get("lead/" + id, { type: "json" })) return 0;
  await s.setJSON("lead/" + id, {
    id, created: Date.now(), name: String(f.name || "").trim(), email, title: String(f.title || "").trim(), company: String(f.company || "").trim(),
    domain: normalizeDomain(f.domain), employees: toint(f.employees), industry: String(f.industry || "").trim(),
    research: null, status: "new", step: 0, last_sent: null, flag: null, score: null, score_reason: null,
    crm_id: null, crm_status: null, dseq: 0, drafts: [], messages: [],
  });
  sup.add(email);
  return 1;
}

export async function getJob() {
  const s = await store();
  return (await s.get("job", { type: "json" })) || {};
}
export async function setJob(j) {
  const s = await store();
  await s.setJSON("job", j);
}
