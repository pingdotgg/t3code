import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";
import {
  canPullUpstream,
  canRunSourceUpdate,
  isSourceUpdateSettled,
  newCommitsLabel,
} from "./sourceUpdate.logic";
import {
  dismissSourceUpdateOutcome,
  useSourceUpdateActions,
  useSourceUpdateEnvironmentId,
  useSourceUpdateState,
} from "./useSourceUpdate";

export function SourceUpdateSettingsRow() {
  const environmentId = useSourceUpdateEnvironmentId();
  return environmentId === null ? null : <SourceUpdateRow environmentId={environmentId} />;
}

function SourceUpdateRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { status, failed, phase } = useSourceUpdateState(environmentId);
  const { update, pullUpstream } = useSourceUpdateActions();
  const description =
    phase.kind === "running"
      ? "Updating. The server restarts when the build finishes."
      : phase.kind === "failed"
        ? `The last update failed: ${phase.message}`
        : phase.kind === "succeeded"
          ? `Updated to ${phase.sha}.`
          : status === null
            ? failed
              ? "Could not read the source checkout. Check the server log."
              : "Checking the checkout…"
            : [
                `Running ${status.head.sha} ${status.head.subject}.`,
                status.behindOrigin
                  ? `origin/main has ${newCommitsLabel(status.behindOrigin)}.`
                  : null,
                status.upstreamAhead
                  ? `upstream/main has ${newCommitsLabel(status.upstreamAhead)}.`
                  : null,
              ]
                .filter(Boolean)
                .join(" ");
  return (
    <SettingsRow
      title="Source checkout"
      description={description}
      control={
        <div className="flex flex-wrap items-center gap-1.5">
          {canRunSourceUpdate(phase) ? (
            <Button size="sm" variant="outline" onClick={() => void update(environmentId)}>
              {phase.kind === "failed" ? "Retry update" : "Update"}
            </Button>
          ) : null}
          {canPullUpstream(status, phase) ? (
            <Button size="sm" variant="outline" onClick={() => void pullUpstream(environmentId)}>
              Pull upstream
            </Button>
          ) : null}
          {isSourceUpdateSettled(phase) ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => dismissSourceUpdateOutcome(environmentId)}
            >
              Dismiss
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
