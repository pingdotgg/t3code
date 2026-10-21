import { createFileRoute } from "@tanstack/react-router";
import { SpacesView } from "../components/SpacesView";

export const Route = createFileRoute("/_chat/spaces")({ component: SpacesView });
