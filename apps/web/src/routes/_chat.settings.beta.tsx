import { createFileRoute } from "@tanstack/react-router";

import { BetaSettingsPanel } from "../components/settings/BetaSettingsPanel";

export const Route = createFileRoute("/_chat/settings/beta")({ component: BetaSettingsPanel });
