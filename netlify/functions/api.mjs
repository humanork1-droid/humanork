import crypto from "node:crypto";
import { E, getJob } from "../lib/db.mjs";
import * as core from "../lib/core.mjs";
import { startJob } from "../lib/jobs.mjs";

export const config = { path: "/api/*" };

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

export default async (req) => {
  try {
    const pw = E("APP_PASSWORD");
    if (!pw) return json({ error: "Set the APP_PASSWORD environment variable in Netlify (Site settings > Environment variables), then redeploy." }, 500);
    const given = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!crypto.timingSafeEqual(digest(given), digest(pw))) return json({ error: "Wrong password" }, 401);

    const path = new URL(req.url).pathname.replace(/^\/api\//, "").replace(/\/$/, "");
    const m = req.method; const b = m === "POST" ? await req.json().catch(() => ({})) : {};
    const seg = path.split("/");

    if (m === "GET") {
      if (path === "state") return json(await core.getState());
      if (path === "insights") return json(await core.insights());
      if (path === "mailbox") return json(await core.verifyMailbox());
      if (path === "job") return json(await getJob());
      if (path === "export.csv") return new Response(await core.exportCsv(), { headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=leads.csv" } });
    }
    if (m === "POST") {
      if (path === "icp") return json(await core.saveIcp(b));
      if (path === "upload") return json(await core.uploadCsv(String(b.csv || "")));
      if (path === "prospect") return json(await core.prospect(b));
      if (path === "job/start") return json(await startJob(new URL(req.url).origin, b.type, b.params || {}));
      if (seg[0] === "draft" && seg[seg.length - 1] === "edit") return json(await core.editDraft(seg.slice(1, -1).join("/"), b));
      if (seg[0] === "draft" && seg[seg.length - 1] === "sent") return json(await core.markSent(seg.slice(1, -1).join("/")));
      if (seg[0] === "lead" && seg[2] === "approve") return json(await core.approve(seg[1]));
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};
