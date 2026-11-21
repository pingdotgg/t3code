import { createFileRoute } from "@tanstack/react-router";
import { PrintersSettingsPanel } from "../components/printer/PrinterSettings";

export const Route = createFileRoute("/_chat/settings/printers")({
  component: PrintersSettingsPanel,
});
