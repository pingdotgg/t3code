import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
} from "@t3tools/contracts";
import { RefreshCw, Unlink } from "lucide-react";
import { useContext, useState } from "react";

import { LinearIcon } from "../../issues/LinearIcon";
import { issueTrackerEnvironment } from "../../state/issues";
import { buttonClass } from "../controls/buttonClass";
import { failureText } from "../failureText";
import { IntegrationCard, subordinateRow } from "./IntegrationCard";
import { IntegrationDetails } from "./IntegrationDetails";
import { LinearKeyDialog } from "./LinearKeyDialog";
import { ProjectTeams } from "./ProjectTeams";

export function LinearCard({
  environmentId,
  tracker,
  bindings,
  checking,
  onRecheck,
}: {
  environmentId: EnvironmentId;
  tracker: IssueTrackerConnection;
  bindings: IssueTrackerConnectionList["bindings"];
  checking: boolean;
  onRecheck: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [dialog, setDialog] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const usable = tracker.connected && tracker.account !== null;
  const rejected = tracker.connected && tracker.account === null;

  const disconnect = async () => {
    setFailure(null);
    const result = await runAtomCommand(
      registry,
      issueTrackerEnvironment.connect,
      { environmentId, input: { tracker: tracker.tracker, token: null } },
      { reportFailure: false, reportDefect: false },
    );
    if (result._tag !== "Success") setFailure(failureText(result));
  };

  return (
    <IntegrationCard
      id="linear"
      icon={<LinearIcon className="size-5" />}
      name={tracker.displayName}
      description={
        usable
          ? `Connected as ${tracker.account}${tracker.workspace === undefined ? "" : ` in ${tracker.workspace}`}.`
          : rejected
            ? (tracker.detail ?? "The saved key was rejected.")
            : "Add Linear access to browse and link issues."
      }
      checking={checking}
      status={
        usable
          ? { label: "Connected", tone: "connected" }
          : rejected
            ? { label: "Key rejected", tone: "attention" }
            : { label: "Not connected", tone: "attention" }
      }
      actions={
        checking ? null : (
          <button type="button" onClick={() => setDialog(true)} className={buttonClass}>
            {tracker.connected ? "Replace access" : "Add Linear access"}
          </button>
        )
      }
    >
      <IntegrationDetails>
        {tracker.connected ? (
          <div className={subordinateRow}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">
                {tracker.workspace ?? tracker.displayName}
              </p>
              <p className="truncate text-xs text-muted">
                {tracker.account ?? "No account"} · {tracker.scopes.length}{" "}
                {tracker.scopes.length === 1 ? tracker.scopeNoun : `${tracker.scopeNoun}s`}
              </p>
            </div>
            <button type="button" onClick={onRecheck} className={buttonClass}>
              <RefreshCw className="mr-1.5 inline size-3" aria-hidden />
              Re-check
            </button>
            <button
              type="button"
              aria-label={`Disconnect ${tracker.displayName}`}
              onClick={() => void disconnect()}
              className="rounded-md p-1 text-faint transition-colors hover:text-red-400"
            >
              <Unlink className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted">
            Add access with a {tracker.credential.label} from your Linear settings. A key with full
            access sees every team its owner can reach.
          </p>
        )}
        {failure !== null && (
          <p role="alert" className="text-xs break-words text-red-400">
            {failure}
          </p>
        )}
        {usable && (
          <ProjectTeams environmentId={environmentId} tracker={tracker} bindings={bindings} />
        )}
        {tracker.connected && (
          <p className="text-[11px] text-faint">
            The engine keeps one key for this connection. Restricted keys can be replaced at any
            time.
          </p>
        )}
      </IntegrationDetails>
      {dialog && (
        <LinearKeyDialog
          environmentId={environmentId}
          tracker={tracker.tracker}
          helpUrl={tracker.credential.helpUrl}
          replacing={tracker.connected}
          onClose={() => setDialog(false)}
        />
      )}
    </IntegrationCard>
  );
}
