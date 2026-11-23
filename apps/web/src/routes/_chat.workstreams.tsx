import { createFileRoute } from "@tanstack/react-router";

import { WorkstreamsPage } from "../kompas/Workstreams";

export const Route = createFileRoute("/_chat/workstreams")({ component: WorkstreamsPage });
