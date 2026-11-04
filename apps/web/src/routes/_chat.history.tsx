import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AgentHistoryPage } from "../components/history/AgentHistoryPage";

const search = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  projectId: Schema.optionalKey(ProjectId),
});

export const Route = createFileRoute("/_chat/history")({
  validateSearch: (raw) => Option.getOrElse(Schema.decodeOption(search)(raw), () => ({})),
  component: HistoryRoute,
});

function HistoryRoute() {
  return <AgentHistoryPage {...Route.useSearch()} />;
}
