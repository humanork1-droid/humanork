import { E } from "../lib/db.mjs";
import { startJob } from "../lib/jobs.mjs";

// Replaces AUTO_RUN's hourly loop. Does nothing unless AUTO_RUN=1.
export default async () => {
  if (E("AUTO_RUN") !== "1") return;
  const origin = E("SITE_URL") || E("URL");
  if (!origin) return;
  await startJob(origin, "pipeline", {});
};
export const config = { schedule: "@hourly" };
