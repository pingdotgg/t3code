import { createFileRoute } from "@tanstack/react-router";
import { RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";

import { CivilizationSettingsPanel } from "../components/settings/CivilizationSettings";

export function validateCivilizationSettingsSearch(raw: Record<string, unknown>) {
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const rawTurn =
    typeof raw.contextTurn === "string" || typeof raw.contextTurn === "number"
      ? Number(raw.contextTurn)
      : Number.NaN;
  const contextTurn = Number.isSafeInteger(rawTurn) && rawTurn >= 1 ? rawTurn : undefined;
  const contextThread = stringValue(raw.contextThread);
  const contextRun = stringValue(raw.contextRun);
  const contextAttempt = stringValue(raw.contextAttempt);
  return {
    ...(contextThread === undefined ? {} : { contextThread: ThreadId.make(contextThread) }),
    ...(contextRun === undefined ? {} : { contextRun: RunId.make(contextRun) }),
    ...(contextAttempt === undefined ? {} : { contextAttempt: RunAttemptId.make(contextAttempt) }),
    ...(contextTurn === undefined ? {} : { contextTurn }),
  };
}

function SettingsCivilizationRoute() {
  const search = Route.useSearch();
  const initialInspectionFilters = {
    ...(search.contextThread === undefined ? {} : { threadId: search.contextThread }),
    ...(search.contextRun === undefined ? {} : { runId: search.contextRun }),
    ...(search.contextAttempt === undefined ? {} : { attemptId: search.contextAttempt }),
    ...(search.contextTurn === undefined ? {} : { providerTurnOrdinal: search.contextTurn }),
  };
  return <CivilizationSettingsPanel initialInspectionFilters={initialInspectionFilters} />;
}

export const Route = createFileRoute("/settings/civilization")({
  validateSearch: validateCivilizationSettingsSearch,
  component: SettingsCivilizationRoute,
});
