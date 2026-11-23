import { createFileRoute } from "@tanstack/react-router";

import { PluginsPage } from "../kompas/PluginsPage";

export const Route = createFileRoute("/_chat/plugins")({ component: PluginsPage });
