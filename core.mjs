import {
  E, sleep, toint, now, CFG, getSettings, saveSettings, getLead, updateLead, allLeads, getSuppression,
  addSuppression, addLead,
} from "./db.mjs";
import { llm, jllm, backend } from "./llm.mjs";

const noop = async () => {};
const UA = { "User-Agent": "Mozilla/5.0 (compatible; AI-SDR/1.0)" };

async function getHtml(url, ms = 8000) {
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(ms) });
    return await r.text();
  } catch { return ""; }
}
const toText = (h) => h.replace(/<(script|style)[\s\S]*?<\/\1>|<[^>]+>/g, " ").replace(/\s+/g, " ");

// ---------------- CSV ----------------
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// ---------------- State ----------------
export function sentToday(leads) {
  const day = new Date().toISOString().slice(0, 10);
  return leads.reduce((n, l) => n + l.messages.filter((m) => m.direction === "out" && m.ts >= day).length, 0);
}

export async function getState() {
  const st = await getSettings(); const leads = await allLeads();
  leads.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.created - a.created);
  const drafts = [], replies = [];
  for (const l of leads) {
    for (const d of l.drafts) if (!d.sent) drafts.push({ ...d, lead_id: l.id, name: l.name, company: l.company });
    for (const m of l.messages) if (m.direction === "in") replies.push({ ...m, lead_id: l.id, name: l.name, company: l.company });
  }
  drafts.sort((a, b) => b.n - a.n);
  replies.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return {
    icp: st.icp || "", cfg: Object.fromEntries(CFG.map((k) => [k, st[k] || ""])),
    leads: leads.map(({ drafts, messages, ...l }) => l), drafts, replies,
    sent_today: sentToday(leads), cap: parseInt(E("DAILY_SEND_CAP", "0"), 10) || 0, draft_only: !E("MAIL_USER") || !E("MAIL_PASS"),
    llm: backend(), auto_run: E("AUTO_RUN") === "1",
  };
}

export async function saveIcp(d) {
  const st = await getSettings();
  for (const k of CFG) st[k] = String(d[k] ?? "");
  await saveSettings(st); return { ok: 1 };
}

export async function uploadCsv(text) {
  if (text.length > 8 * 1024 * 1024) return { error: "CSV is too large. Upload a file smaller than 8 MB." };
  const sup = await getSuppression(); let n = 0;
  let skipped = 0;
  for (const r of parseCsv(text)) {
    const before = n;
    n += await addLead(sup, r);
    if (n === before) skipped++;
  }
  return { added: n, skipped, summary: `Added ${n} leads${skipped ? `; skipped ${skipped} invalid or duplicate rows` : ""}.` };
}

export async function prospect(d) {
  const key = E("APOLLO_API_KEY");
  if (!key) return { error: "Set APOLLO_API_KEY or upload a CSV instead." };
  const r = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST", headers: { "X-Api-Key": key, "Content-Type": "application/json" }, signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      person_titles: d.titles || ["VP Sales", "Head of Sales"], q_keywords: d.keywords || "",
      organization_num_employees_ranges: [d.size || "11,200"], per_page: parseInt(d.limit || 25, 10),
    }),
  });
  const j = await r.json(); const sup = await getSuppression(); let n = 0;
  for (const p of j.people || []) {
    const o = p.organization || {};
    n += await addLead(sup, { name: p.name, email: p.email, title: p.title, company: o.name, domain: o.primary_domain, employees: o.estimated_num_employees, industry: o.industry });
  }
  return { added: n, summary: `Added ${n} leads from Apollo.` };
}

// ---------------- Research / scoring / drafting ----------------
export async function research(lid) {
  const l = await getLead(lid); const st = await getSettings(); let text = "";
  if (l.domain) {
    try {
      const r = await fetch(`https://${l.domain}`, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) });
      text = toText(await r.text()).slice(0, 6000);
    } catch (e) { text = `(site fetch failed: ${e.message})`; }
  }
  const out = await llm("You are a sales researcher. From the website text, write 3-4 concise bullets: what the company does, who they sell to, and one specific, true hook for outreach. Never invent facts.",
    `Company: ${l.company}\nPerson: ${l.name}, ${l.title}\nOur ICP: ${st.icp || ""}\nWebsite text: ${text}`);
  await updateLead(lid, (x) => { x.research = out; x.status = "researched"; });
  return { research: out };
}

const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "proton.me", "protonmail.com"]);
const TOP = /founder|owner|ceo|chief|cro|cmo|coo|president/;
const SENIOR = /\bvp\b|vice president|head of|director/;

function ruleScore(st, l) {
  let pts = 0; const why = []; const t = (l.title || "").toLowerCase();
  if (TOP.test(t)) { pts += 20; why.push("top decision maker"); }
  else if (SENIOR.test(t)) { pts += 18; why.push("senior buyer"); }
  else if (t.includes("manager")) { pts += 10; why.push("manager"); }
  else pts += 3;
  const targets = (st.titles || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (targets.some((x) => t.includes(x))) { pts += 10; why.push("title matches target"); }
  const lo = toint(st.min_emp), hi = toint(st.max_emp), n = l.employees;
  if (n == null) { pts += 5; why.push("size unknown"); }
  else if ((lo == null || n >= lo) && (hi == null || n <= hi)) { pts += 10; why.push(`${n} employees fits`); }
  else why.push(`${n} employees outside range`);
  const ed = (l.email || "").split("@").pop();
  if (ed && !FREE_MAIL.has(ed)) { pts += 5; why.push("business email"); if (l.domain && ed.endsWith(l.domain)) pts += 5; }
  return [pts, why];
}

export async function scoreLead(lid) {
  let l = await getLead(lid); const st = await getSettings();
  if (!l.research) { await research(lid); l = await getLead(lid); }
  const [pts, why] = ruleScore(st, l); let fit;
  try {
    const r = await jllm('Rate how well this company and person match the ideal customer profile. Be strict; only strong matches get 8+. JSON: {"fit": integer 0-10, "reason": "one short sentence"}',
      `ICP: ${st.icp || ""}\nPerson: ${l.title} at ${l.company} (${l.industry || "industry unknown"})\nResearch:\n${l.research}`);
    fit = Math.max(0, Math.min(10, parseInt(r.fit, 10))); if (Number.isNaN(fit)) throw new Error("bad fit");
    why.push(`AI fit ${fit}/10: ${r.reason || ""}`);
  } catch { fit = 5; why.push("AI fit unavailable"); }
  const total = pts + fit * 5;
  await updateLead(lid, (x) => { x.score = total; x.score_reason = why.join("; "); });
  return { score: total };
}

export async function draft(lid) {
  let l = await getLead(lid);
  if (!l.research) { await research(lid); l = await getLead(lid); }
  let seq = await jllm('You are an expert B2B SDR. Write a 3-email cold sequence: email 1 (under 90 words, one specific hook, soft ask for interest, no meeting link), email 2 (follow-up, new angle, under 60 words), email 3 (short breakup, under 40 words). Plain text, human, no hype, no fake claims, no placeholders. Do not include an unsubscribe line. JSON: [{"subject":..,"body":..} x3]',
    `Sender pitch: ${E("COMPANY_PITCH")}\nSender name: ${E("FROM_NAME")}\nProspect: ${l.name}, ${l.title} at ${l.company}\nResearch:\n${l.research}`);
  if (!Array.isArray(seq)) seq = Object.values(seq).find(Array.isArray) || [seq];
  seq = seq.filter((e) => e && e.subject && e.body).slice(0, 3);
  if (!seq.length) throw new Error("Model returned no usable emails. Try again.");
  await updateLead(lid, (x) => {
    x.drafts = x.drafts.filter((d) => d.sent);
    seq.forEach((e, i) => { x.dseq += 1; x.drafts.push({ id: `${x.id}-${x.dseq}`, n: x.dseq, step: i, subject: String(e.subject), body: String(e.body), approved: 0, sent: 0 }); });
    x.status = "drafted";
  });
  return { ok: 1 };
}

export async function autopilot(d = {}, progress = noop) {
  const st = await getSettings(); const thr = toint(st.threshold) || 60; const limit = parseInt(d.limit || 10, 10);
  let scored = 0, drafted = 0, failed = 0; let leads = await allLeads();
  const todo = leads.filter((l) => l.score == null && ["new", "researched"].includes(l.status)).slice(0, limit);
  for (const l of todo) {
    await progress(`Scoring ${scored + 1}/${todo.length}: ${l.company || l.name}`);
    try { await scoreLead(l.id); scored++; } catch { failed++; }
  }
  leads = await allLeads();
  const hi = leads.filter((l) => l.score != null && l.score >= thr && ["new", "researched"].includes(l.status)).sort((a, b) => b.score - a.score).slice(0, limit);
  for (const l of hi) {
    await progress(`Writing emails ${drafted + 1}/${hi.length}: ${l.company || l.name}`);
    try { await draft(l.id); drafted++; } catch { failed++; }
  }
  return { scored, drafted, failed, threshold: thr };
}

// ---------------- Approve / edit / mark sent ----------------
const lidOf = (did) => String(did).split("-")[0];

export async function editDraft(did, d) {
  await updateLead(lidOf(did), (l) => { const x = l.drafts.find((y) => y.id === did); if (x) { x.subject = d.subject; x.body = d.body; } });
  return { ok: 1 };
}
export async function approve(lid) {
  await updateLead(lid, (l) => { l.drafts.forEach((d) => { if (!d.sent) d.approved = 1; }); if (l.status === "drafted") l.status = "approved"; });
  return { ok: 1 };
}
export async function markSent(did) {
  await updateLead(lidOf(did), (l) => {
    const d = l.drafts.find((y) => y.id === did); if (!d) return;
    const ts = now(); d.sent = 1; d.approved = 1;
    l.messages.push({ direction: "out", body: d.body, ts }); l.step += 1; l.last_sent = ts; l.status = "sequencing";
  });
  return { ok: 1 };
}

// ---------------- Sending / inbox ----------------
async function mailer() {
  const nodemailer = (await import("nodemailer")).default;
  const port = parseInt(E("SMTP_PORT", "587"), 10);
  return nodemailer.createTransport({ host: E("SMTP_HOST", "smtp.gmail.com"), port, secure: port === 465, requireTLS: port !== 465, auth: { user: E("MAIL_USER"), pass: E("MAIL_PASS") } });
}

export async function verifyMailbox() {
  if (!E("MAIL_USER") || !E("MAIL_PASS")) return { connected: false, error: "Set MAIL_USER and MAIL_PASS in Netlify environment variables first." };
  try {
    const tx = await mailer();
    await tx.verify();
    return { connected: true, user: E("MAIL_USER"), host: E("SMTP_HOST", "smtp.gmail.com"), summary: "Mailbox connection verified." };
  } catch (e) {
    return { connected: false, error: `Mailbox verification failed: ${e.message}` };
  }
}

export async function sendDue(progress = noop, deadline = Date.now() + 12 * 60000) {
  if (!E("MAIL_USER") || !E("MAIL_PASS")) return { error: "Mailbox is not connected. Set MAIL_USER and MAIL_PASS, then verify the connection." };
  const leads = await allLeads(); const sup = await getSuppression();
  const capn = parseInt(E("DAILY_SEND_CAP", "0"), 10) || 0; const cap = capn ? capn - sentToday(leads) : Infinity;
  const days = parseInt(E("FOLLOWUP_DAYS", "3"), 10); let sent = 0; let tx;
  for (const l of leads) {
    if (!l.email || !/^\S+@\S+\.\S+$/.test(l.email)) continue;
    if (!["approved", "sequencing"].includes(l.status)) continue;
    if (sent >= cap || Date.now() > deadline) break;
    if (sup.has(l.email)) continue;
    if (l.last_sent && new Date(l.last_sent) > new Date(Date.now() - days * 86400000)) continue;
    const d = l.drafts.find((x) => x.step === l.step && x.approved && !x.sent);
    if (!d) { if (l.step >= 3) await updateLead(l.id, (x) => { x.status = "finished"; }); continue; }
    try {
      tx = tx || (await mailer());
      await tx.sendMail({
        from: `${E("FROM_NAME")} <${E("MAIL_USER")}>`, to: l.email, subject: d.subject,
        headers: { "List-Unsubscribe": `<mailto:${E("MAIL_USER")}?subject=unsubscribe>` },
        text: `${d.body}\n\n--\n${E("FROM_NAME")}\n${E("PHYSICAL_ADDRESS")}\nNot relevant? Reply "unsubscribe" and I won't email again.`,
      });
    } catch (e) { return { error: e.message, sent }; }
    const ts = now();
    await updateLead(l.id, (x) => {
      const dd = x.drafts.find((y) => y.id === d.id); if (dd) dd.sent = 1;
      x.messages.push({ direction: "out", body: d.body, ts }); x.step += 1; x.last_sent = ts; x.status = "sequencing";
    });
    sent++; await progress(`Sent ${sent}`); await sleep(2000);
  }
  return { sent, summary: `Sent ${sent} email${sent === 1 ? "" : "s"}.` };
}

const LABELS = "interested, not_now, wrong_person, objection, question, unsubscribe, out_of_office, other";

export async function handleReply(lid, text) {
  const l = await getLead(lid);
  const r = await jllm(`Classify this reply to a cold email. Label one of: ${LABELS}. If wrong_person, extract any referred contact. Draft a short, honest reply for interested/question/objection/not_now (never book or propose meeting times; if they are interested, thank them and say a teammate will follow up). JSON: {"label":..,"reply":..,"referral":..}`,
    `Our pitch: ${E("COMPANY_PITCH")}\nReply from ${l.name}:\n${text}`);
  let lab = r.label;
  const unsub = lab === "unsubscribe" || /\bunsubscribe\b|\bremove me\b|\bstop\b/i.test(text);
  if (unsub) { lab = "unsubscribe"; await addSuppression(l.email); }
  await updateLead(lid, (x) => {
    if (unsub) x.status = "unsubscribed";
    else if (lab === "interested") { x.status = "interested"; x.flag = "HUMAN: follow up"; }
    else if (lab === "wrong_person" || lab === "not_now") x.status = lab;
    else x.status = "replied";
    x.messages.push({ direction: "in", body: text, label: lab, ts: now(),
      suggested: (r.reply || "") + (r.referral ? `\n[Referral: ${typeof r.referral === "string" ? r.referral : JSON.stringify(r.referral)}]` : "") });
  });
  return { ok: 1, summary: `Reply classified as ${lab}.` };
}

export async function pasteReply(lid, text) {
  if (!lid || !text) return { error: "Pick a lead and paste the reply." };
  return handleReply(lid, text);
}

export async function checkInbox(progress = noop) {
  if (!E("MAIL_USER")) return { error: "Set MAIL_USER/MAIL_PASS" };
  const { ImapFlow } = await import("imapflow"); const { simpleParser } = await import("mailparser");
  const leads = await allLeads(); const byEmail = new Map(leads.map((l) => [l.email, l]));
  const client = new ImapFlow({ host: E("IMAP_HOST", "imap.gmail.com"), port: 993, secure: true, auth: { user: E("MAIL_USER"), pass: E("MAIL_PASS") }, logger: false });
  let n = 0; await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      const mine = [];
      if (uids.length) for await (const m of client.fetch(uids, { envelope: true }, { uid: true })) {
        const from = (m.envelope?.from?.[0]?.address || "").toLowerCase();
        if (byEmail.has(from)) mine.push({ uid: m.uid, lead: byEmail.get(from) });
      }
      for (const { uid, lead } of mine) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        const parsed = await simpleParser(msg.source);
        await progress(`Reading reply from ${lead.name}`);
        await handleReply(lead.id, (parsed.text || "").split("\nOn ")[0].slice(0, 3000));
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); n++;
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  return { processed: n, summary: `Processed ${n} repl${n === 1 ? "y" : "ies"}.` };
}

// ---------------- Free prospecting from the open web ----------------
const SKIP = ["linkedin", "facebook", "twitter", "x.com", "youtube", "wikipedia", "crunchbase", "g2.com", "capterra", "reddit", "glassdoor", "indeed", "instagram", "medium.com", "github", "yelp", "zoominfo", "apollo.io", "forbes", "techcrunch", "bloomberg", "amazon", "google", "microsoft", "quora", "pinterest", "tiktok", "clutch.co", "trustpilot", "duckduckgo", "bing.com"];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const domOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

async function webSearch(q) {
  const out = [];
  const h = await getHtml("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), 12000);
  for (const m of h.matchAll(/class="result__a"[^>]*href="([^"]+)"/g)) {
    try {
      const href = m[1].replace(/&amp;/g, "&"); const u = new URL(href.startsWith("//") ? "https:" + href : href, "https://duckduckgo.com");
      out.push(u.searchParams.get("uddg") || href);
    } catch { /* ignore */ }
  }
  if (out.length) return out;
  // Fallback: Bing (DuckDuckGo sometimes blocks datacenter IPs)
  const b = await getHtml("https://www.bing.com/search?q=" + encodeURIComponent(q), 12000);
  for (const m of b.matchAll(/<li class="b_algo"[\s\S]*?<a [^>]*href="([^"]+)"/g)) {
    let href = m[1].replace(/&amp;/g, "&");
    try {
      const u = new URL(href);
      if (u.hostname.endsWith("bing.com") && (u.searchParams.get("u") || "").startsWith("a1"))
        href = Buffer.from(u.searchParams.get("u").slice(2), "base64url").toString();
    } catch { /* ignore */ }
    out.push(href);
  }
  return out;
}

export async function discover(d = {}, progress = noop) {
  const st = await getSettings(); const icp = st.icp;
  if (!icp) return { error: "Describe your ICP in Setup first." };
  const limit = parseInt(d.limit || 10, 10); let added = 0, tried = 0;
  let qs = await jllm("Write 4 different web search queries that would surface the websites of companies matching this ideal customer profile (company sites, not lists or directories). JSON array of strings.", icp);
  if (!Array.isArray(qs)) qs = Object.values(qs).find(Array.isArray) || [];
  const domains = [];
  for (const q of qs.slice(0, 4)) {
    await progress(`Searching: ${String(q).slice(0, 60)}`);
    for (const u of await webSearch(String(q))) {
      const dom = domOf(u);
      if (dom && !SKIP.some((x) => dom.includes(x)) && !domains.includes(dom)) domains.push(dom);
    }
    await sleep(1500);
  }
  const sup = await getSuppression(); const known = new Set((await allLeads()).map((l) => l.domain));
  for (const dom of domains) {
    if (added >= limit || tried >= limit * 4) break;
    if (known.has(dom)) continue;
    tried++; await progress(`Checking ${dom} (${added}/${limit} leads found)`);
    const pages = await Promise.all(["", "/about", "/about-us", "/team", "/contact", "/company"].map((p) => getHtml(`https://${dom}${p}`)));
    const raw = pages.join(" ");
    const emails = [...new Set((raw.match(EMAIL_RE) || []).map((e) => e.toLowerCase()).filter((e) => e.endsWith(dom) && !/noreply|no-reply|\.(png|jpg|gif|svg|webp)$/i.test(e)))].sort();
    if (!emails.length) continue;
    let r;
    try {
      r = await jllm('From this website text, list the company name and up to 2 people to contact (prefer decision makers). Use ONLY people and emails that appear in the text/emails list; never guess or invent. JSON: {"company":"","contacts":[{"name":"","title":"","email":""}]}',
        `ICP: ${icp}\nDomain: ${dom}\nEmails found: ${JSON.stringify(emails)}\nText: ${toText(raw).slice(0, 7000)}`);
    } catch { continue; }
    for (const p of (r.contacts || []).slice(0, 2))
      if (emails.includes((p.email || "").toLowerCase()))
        added += await addLead(sup, { name: p.name, email: p.email, title: p.title, company: r.company || dom, domain: dom });
  }
  return { added, summary: `Checked ${tried} companies, added ${added} leads. Only public contact details are used.` };
}

// ---------------- CRM ----------------
const HS = "https://api.hubapi.com/crm/v3/objects/contacts";
const HS_STATUS = { new: "NEW", researched: "NEW", drafted: "NEW", approved: "NEW", sequencing: "ATTEMPTED_TO_CONTACT", finished: "ATTEMPTED_TO_CONTACT", replied: "CONNECTED", interested: "CONNECTED", not_now: "BAD_TIMING", wrong_person: "UNQUALIFIED", unsubscribed: "UNQUALIFIED" };

export async function crmSync(progress = noop) {
  const tok = E("HUBSPOT_TOKEN");
  if (!tok) return { error: "Set HUBSPOT_TOKEN (HubSpot private app token) or use Export CSV to import into any CRM." };
  const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }; let n = 0;
  const call = (method, url, body) => fetch(url, { method, headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  for (const l of (await allLeads()).filter((x) => !x.crm_id || x.crm_status !== x.status)) {
    const [first, ...rest] = (l.name || "").split(" ");
    const props = { email: l.email, firstname: first || "", lastname: rest.join(" "), jobtitle: l.title || "", company: l.company || "", website: l.domain || "", hs_lead_status: HS_STATUS[l.status] || "NEW" };
    try {
      let cid = l.crm_id; let r;
      if (cid) r = await call("PATCH", `${HS}/${cid}`, { properties: props });
      else {
        r = await call("POST", HS, { properties: props });
        if (r.status === 409) {
          const m = (await r.text()).match(/Existing ID: (\d+)/); cid = m ? m[1] : null;
          r = cid ? await call("PATCH", `${HS}/${cid}`, { properties: props }) : r;
        } else if (r.ok) cid = (await r.json()).id;
      }
      if (r.status < 300 && cid) { await updateLead(l.id, (x) => { x.crm_id = cid; x.crm_status = l.status; }); n++; await progress(`Synced ${n}`); }
    } catch { /* skip */ }
  }
  return { synced: n, summary: `Synced ${n} contacts to HubSpot.` };
}

export async function exportCsv() {
  const rows = [["name", "email", "title", "company", "domain", "employees", "industry", "score", "status", "emails_sent"]];
  for (const l of (await allLeads()).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)))
    rows.push([l.name, l.email, l.title, l.company, l.domain, l.employees, l.industry, l.score, l.status, l.step]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

// ---------------- Insights ----------------
const sizeBand = (n) => (n == null ? "unknown" : n < 20 ? "under 20" : n <= 50 ? "20-50" : n <= 200 ? "51-200" : "200+");
const seniority = (t) => { t = (t || "").toLowerCase(); return TOP.test(t) ? "founder/C-level" : SENIOR.test(t) ? "VP/head/director" : t.includes("manager") ? "manager" : "other/unknown"; };
const band = (s) => (s == null ? "no score" : s >= 80 ? "80-100" : s >= 60 ? "60-79" : s >= 40 ? "40-59" : "0-39");

export async function insights() {
  const st = await getSettings();
  const rows = (await allLeads()).filter((l) => l.step > 0).map((l) => ({ ...l,
    replied: l.messages.some((m) => m.direction === "in" && !["unsubscribe", "out_of_office"].includes(m.label)) ? 1 : 0, positive: l.status === "interested" ? 1 : 0 }));
  const out = [], tot = rows.length;
  const factors = [["Score", (l) => band(l.score)], ["Seniority", (l) => seniority(l.title)], ["Company size", (l) => sizeBand(l.employees)], ["Email that got the reply", (l) => `Email ${l.step}`]];
  for (const [factor, fn] of factors) {
    const g = {};
    for (const l of rows) {
      if (factor.startsWith("Email") && !l.replied) continue;
      const a = (g[fn(l)] ||= [0, 0, 0]); a[0]++; a[1] += l.replied; a[2] += l.positive;
    }
    for (const k of Object.keys(g).sort()) { const [n, rp, ps] = g[k]; out.push({ factor, group: k, leads: n, replies: rp, reply_rate: n ? Math.round((100 * rp) / n) : 0, positive: ps }); }
  }
  let tip = "Not enough data yet. Insights appear after roughly 50 leads have been contacted.";
  if (tot >= 50) {
    const sb = out.filter((o) => o.factor === "Score" && o.leads >= 5 && o.group !== "no score");
    if (sb.length) {
      const b = sb.reduce((a, c) => (c.reply_rate > a.reply_rate ? c : a)); const lo = { "80-100": 80, "60-79": 60, "40-59": 40, "0-39": 0 }[b.group];
      const thr = toint(st.threshold) || 60;
      tip = `Best reply rate is in the ${b.group} band (${b.reply_rate}%).` + (lo > thr ? ` Consider raising your minimum score to ${lo}.` : " Your current minimum score looks right.");
    }
  }
  return { contacted: tot, rows: out, tip };
}

// ---------------- Full pipeline ----------------
export async function runPipeline(d = {}, progress = noop) {
  const out = {}; const n = parseInt(d.discover ?? E("DISCOVER_PER_RUN", "0"), 10) || 0;
  if (E("MAIL_USER")) { await progress("Reading replies"); try { out.inbox = await checkInbox(progress); } catch (e) { out.inbox = { error: e.message }; } }
  if (n) { await progress("Finding new leads"); out.discover = await discover({ limit: n }, progress); }
  out.autopilot = await autopilot({ limit: 25 }, progress);
  if (E("AUTO_APPROVE") === "1") {
    for (const l of (await allLeads()).filter((x) => x.status === "drafted"))
      await updateLead(l.id, (x) => { x.drafts.forEach((y) => { if (!y.sent) y.approved = 1; }); x.status = "approved"; });
  }
  await progress("Syncing CRM"); out.crm = await crmSync(progress);
  await progress("Sending"); out.send = await sendDue(progress);
  const bits = [`Scored ${out.autopilot.scored}, drafted ${out.autopilot.drafted}`, `sent ${out.send.sent || 0}`];
  if (out.discover && "added" in out.discover) bits.unshift(`found ${out.discover.added} new leads`);
  if (out.send.error) bits.push(out.send.error);
  const s = bits.join(". ");
  out.summary = s.charAt(0).toUpperCase() + s.slice(1) + ".";
  return out;
}
