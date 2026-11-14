import { createFileRoute } from "@tanstack/react-router";
import { NativeToolsSettings } from "../components/settings/NativeToolsSettings";

export const Route = createFileRoute("/_chat/settings/tools")({ component: NativeToolsSettings });
