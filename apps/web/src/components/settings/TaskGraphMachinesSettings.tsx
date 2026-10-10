import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TaskGraphPeer } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type FormEvent, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { EnvironmentRow } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { loadPreferenceForWeight, loadPreferences } from "./LoadBalancingSettings";
import { searchableSetting } from "./settingsSearch";

const statusBadgeVariant = {
  connected: "success",
  connecting: "info",
  unreachable: "warning",
  unauthorized: "error",
} as const satisfies Record<TaskGraphPeer["status"], string>;

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * Closed-header summary: every peer by name, with its status when it is not
 * connected, so a broken machine shows without opening the section.
 */
function summarizeTaskGraphPeers(peers: ReadonlyArray<TaskGraphPeer>): string {
  if (peers.length === 0) return "None";
  return peers
    .map((peer) => (peer.status === "connected" ? peer.label : `${peer.label} ${peer.status}`))
    .join(" · ");
}

/**
 * Folded section listing the machines the given environment may run task graph
 * nodes on. The list lives on that server, so it is shared by every client and
 * editing it needs the environment's maintain permission; without it the list
 * is read-only.
 */
export function TaskGraphMachinesSettings({
  environment,
}: {
  readonly environment: EnvironmentPresentation | null;
}) {
  const environmentId = environment?.environmentId ?? null;
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const peersQuery = useEnvironmentQuery(
    connected && environmentId !== null
      ? serverEnvironment.taskGraphPeersLive({ environmentId, input: {} })
      : null,
  );
  const canAdd = useAtomValue(serverEnvironment.addTaskGraphPeer.permissionAtom(environmentId));

  if (environmentId === null || !connected) return null;

  const peers = peersQuery.data?.peers ?? [];
  const { id, title } = searchableSetting("task-graph-machines");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={peersQuery.data ? summarizeTaskGraphPeers(peers) : null}
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Let agents' task graphs run nodes on your other machines. Paste a pairing link from the
        other machine; this machine gets access to start, watch and stop threads and push branches
        there, nothing else.
      </p>
      {peersQuery.error && !peersQuery.data ? (
        <p className="px-3 py-2.5 text-xs text-destructive sm:px-4">{peersQuery.error}</p>
      ) : null}
      {peers.map((peer) => (
        <TaskGraphPeerRow key={peer.environmentId} environmentId={environmentId} peer={peer} />
      ))}
      {peers.length > 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          This machine's session also shows in each machine's connected clients, where it can be
          revoked.
        </p>
      ) : null}
      {canAdd ? <AddTaskGraphPeerForm environmentId={environmentId} /> : null}
    </FoldedSettingsSection>
  );
}

function TaskGraphPeerRow({
  environmentId,
  peer,
}: {
  readonly environmentId: EnvironmentId;
  readonly peer: TaskGraphPeer;
}) {
  const canSetWeight = useAtomValue(
    serverEnvironment.setTaskGraphPeerWeight.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    serverEnvironment.removeTaskGraphPeer.permissionAtom(environmentId),
  );
  const setWeight = useAtomCommand(serverEnvironment.setTaskGraphPeerWeight, {
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.removeTaskGraphPeer, { reportFailure: false });
  const [busy, setBusy] = useState(false);

  const run = async <A, E>(
    action: () => Promise<AtomCommandResult<A, E>>,
    failureTitle: string,
  ) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: failureMessage(squashAtomCommandFailure(result), "Try again."),
        }),
      );
    }
  };

  const confirmRemove = async () => {
    // No mounted confirm host means no removal.
    const confirmed = await requestConfirmDialog(
      `Remove ${peer.label}?\nTask graphs stop running nodes there.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await run(
      () => remove({ environmentId, input: { environmentId: peer.environmentId } }),
      `Could not remove ${peer.label}`,
    );
  };

  return (
    <EnvironmentRow
      kind="server"
      label={peer.label}
      subtitle={peer.httpBaseUrl}
      below={peer.error ? <p className="text-xs text-destructive">{peer.error}</p> : null}
    >
      <Badge variant={statusBadgeVariant[peer.status]}>{peer.status}</Badge>
      <Select
        items={loadPreferences}
        value={loadPreferenceForWeight(peer.weight)}
        disabled={busy || !canSetWeight}
        onValueChange={(weight) => {
          if (weight === null) return;
          void run(
            () =>
              setWeight({ environmentId, input: { environmentId: peer.environmentId, weight } }),
            `Could not update ${peer.label}`,
          );
        }}
      >
        <SelectTrigger
          size="xs"
          className="w-32"
          aria-label={`${peer.label} task graph preference`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {loadPreferences.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {canRemove ? (
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={busy}
          onClick={() => void confirmRemove()}
        >
          Remove
        </Button>
      ) : null}
    </EnvironmentRow>
  );
}

function AddTaskGraphPeerForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const add = useAtomCommand(serverEnvironment.addTaskGraphPeer, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedUrl = pairingUrl.trim();
    if (adding || trimmedUrl.length === 0) return;
    const trimmedLabel = label.trim();
    setAdding(true);
    setError(null);
    const result = await add({
      environmentId,
      input: {
        pairingUrl: trimmedUrl,
        ...(trimmedLabel.length > 0 ? { label: trimmedLabel } : {}),
      },
    });
    setAdding(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(failureMessage(squashAtomCommandFailure(result), "Could not add the machine."));
      }
      return;
    }
    setPairingUrl("");
    setLabel("");
  };

  return (
    <form className="space-y-2 px-3 py-2.5 sm:px-4" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          size="sm"
          className="sm:flex-1"
          value={pairingUrl}
          onChange={(event) => setPairingUrl(event.target.value)}
          placeholder="Pairing link"
          aria-label="Pairing link from the other machine"
          disabled={adding}
        />
        <Input
          size="sm"
          className="sm:w-40"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label (optional)"
          aria-label="Machine label"
          maxLength={80}
          disabled={adding}
        />
        <Button type="submit" size="sm" disabled={adding || pairingUrl.trim().length === 0}>
          {adding ? <Spinner size="sm" /> : null}
          Add machine
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
