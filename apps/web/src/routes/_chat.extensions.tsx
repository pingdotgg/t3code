// Fork: Kaluwa's Extensions page
import { createFileRoute } from "@tanstack/react-router";

import { ExtensionsPage } from "../components/extensions/ExtensionsPage";

export const Route = createFileRoute("/_chat/extensions")({
  component: ExtensionsPage,
});
