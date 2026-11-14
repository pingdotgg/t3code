import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsPage, type WorkflowsSearch } from "../components/workflows/WorkflowsPage";

export const Route = createFileRoute("/_chat/workflows")({
  validateSearch: (raw: Record<string, unknown>): WorkflowsSearch => ({
    ...(typeof raw.env === "string" && raw.env ? { env: raw.env.slice(0, 200) } : {}),
    ...(typeof raw.run === "string" && raw.run ? { run: raw.run.slice(0, 200) } : {}),
    ...(typeof raw.thread === "string" && raw.thread ? { thread: raw.thread.slice(0, 200) } : {}),
    ...(typeof raw.threadEnv === "string" && raw.threadEnv
      ? { threadEnv: raw.threadEnv.slice(0, 200) }
      : {}),
    ...(raw.file === true || raw.file === "true" || raw.file === 1 ? { file: true } : {}),
  }),
  component: WorkflowsPage,
});
