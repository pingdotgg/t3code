import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";
import {
  canCancelSourceUpdate,
  canPullUpstream,
  canRunSourceUpdate,
  isSourceUpdateSettled,
  newCommitsLabel,
  unbuiltCommitsLabel,
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
  const { update, cancel, pullUpstream } = useSourceUpdateActions();
  const description =
    phase.kind === "running"
      ? "Updating. The server restarts when the build finishes."
      : phase.kind === "failed"
        ? `The last update failed: ${phase.message}`
        : phase.kind === "succeeded"
          ? phase.message || `Updated to ${phase.sha}.`
          : status === null
            ? failed
              ? "Could not read the source checkout. Check the server log."
              : "Checking the checkout…"
            : [
                `Checkout at ${status.head.sha} ${status.head.subject}.`,
                status.unbuiltCommits
                  ? `${unbuiltCommitsLabel(status.unbuiltCommits)} into the running server yet.`
                  : null,
                status.behindOrigin
                  ? `origin/main has ${newCommitsLabel(status.behindOrigin)}.`
                  : null,
                status.upstreamAhead
                  ? `upstream/main has ${newCommitsLabel(status.upstreamAhead)}.`
                  : null,
                status.updateUnavailableReason,
                status.upstreamAhead && status.pullUpstreamUnavailableReason
                  ? `Pull upstream: ${status.pullUpstreamUnavailableReason}`
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
          {canCancelSourceUpdate(phase) ? (
            <Button size="sm" variant="outline" onClick={() => void cancel(environmentId)}>
              Cancel update
            </Button>
          ) : null}
          {canRunSourceUpdate(status, phase) ? (
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
              onClick={() => dismissSourceUpdateOutcome(environmentId, phase)}
            >
              Dismiss
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
