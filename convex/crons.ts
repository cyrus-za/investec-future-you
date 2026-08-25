import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "sync investec accounts and transactions",
  { hours: 4 },
  internal.investec.sync.run,
  { triggeredBy: "cron" },
);

export default crons;
