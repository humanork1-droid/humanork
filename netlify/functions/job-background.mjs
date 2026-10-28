import { runJob, jobSecret } from "../lib/jobs.mjs";

// Background function (file name ends in -background): returns 202 right away, keeps running up to 15 min.
export default async (req) => {
  if (!jobSecret() || req.headers.get("x-job-secret") !== jobSecret()) return new Response("forbidden", { status: 403 });
  const { type, params } = await req.json();
  await runJob(type, params || {});
};
