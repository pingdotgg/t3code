import { createFileRoute } from "@tanstack/react-router";

import { MemoryPage } from "../kompas/MemoryPage";

export const Route = createFileRoute("/_chat/memory")({ component: MemoryPage });
