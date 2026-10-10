import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TaskGraphPeer } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type FormEvent, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Option from "effect/Option";
import { environmentSession, readPreparedConnection } from "~/state/session";
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
  environments,
}: {
  readonly environment: EnvironmentPresentation | null;
  /** This client's machines; connected ones can be added in one step. */
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
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
        Let agents' task graphs run nodes on your other machines. Add one this app is connected to,
        including over T3 Connect, or paste a pairing link from it; this machine gets access to
        start, watch and stop threads and push branches there, nothing else.
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
      {canAdd
        ? environments
            .filter(
              (candidate) =>
                candidate.environmentId !== environmentId &&
                candidate.connection.phase === "connected" &&
                !peers.some((peer) => peer.environmentId === candidate.environmentId),
            )
            .map((candidate) => (
              <ConnectedMachineRow
                key={candidate.environmentId}
                environmentId={environmentId}
                environmentLabel={environment?.label ?? "This machine"}
                candidate={candidate}
              />
            ))
        : null}
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
    let result: AtomCommandResult<A, E>;
    try {
      result = await action();
    } finally {
      setBusy(false);
    }
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

/**
 * A machine this client is connected to but the environment has not paired.
 * Adding asks that machine for a short-lived grant and hands it, with the
 * address this client reaches it at, to the environment. That address is the
 * T3 Connect hostname for a relay connection, so relay-only machines work too.
 */
const hostnameOf = (url: string | undefined): string | null => {
  if (url === undefined) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

function ConnectedMachineRow({
  environmentId,
  environmentLabel,
  candidate,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly candidate: EnvironmentPresentation;
}) {
  const canGrant = useAtomValue(
    serverEnvironment.issueTaskGraphPeerGrant.permissionAtom(candidate.environmentId),
  );
  const issueGrant = useAtomCommand(serverEnvironment.issueTaskGraphPeerGrant, {
    reportFailure: false,
  });
  const add = useAtomCommand(serverEnvironment.addTaskGraphPeer, { reportFailure: false });
  const candidateUrl = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(candidate.environmentId)),
  )?.httpBaseUrl;
  const targetUrl = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId)),
  )?.httpBaseUrl;
  // The environment redeems the pairing at the address this app uses. A loopback address only
  // works when this app also reaches the environment on loopback, so both run on this computer.
  const candidateHost = hostnameOf(candidateUrl);
  const targetHost = hostnameOf(targetUrl);
  const unreachable =
    candidateHost !== null &&
    targetHost !== null &&
    isLoopbackHost(candidateHost) &&
    !isLoopbackHost(targetHost);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commandError = (result: AtomCommandResult<unknown, unknown>, fallback: string) =>
    result._tag === "Failure" && !isAtomCommandInterrupted(result)
      ? failureMessage(squashAtomCommandFailure(result), fallback)
      : null;

  const addMachine = async () => {
    const connection = readPreparedConnection(candidate.environmentId);
    if (adding || connection === null || unreachable) return;
    setAdding(true);
    setError(null);
    try {
      const grant = await issueGrant({
        environmentId: candidate.environmentId,
        input: { label: environmentLabel },
      });
      if (grant._tag !== "Success") {
        setError(commandError(grant, `${candidate.label} would not issue a pairing grant.`));
        return;
      }
      const pairingUrl = new URL("/pair", connection.httpBaseUrl);
      pairingUrl.hash = `token=${grant.value.credential}`;
      const result = await add({
        environmentId,
        input: { pairingUrl: pairingUrl.toString(), label: candidate.label },
      });
      setError(commandError(result, `Could not add ${candidate.label}.`));
    } catch {
      setError(`Could not add ${candidate.label}.`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-1 px-3 py-2 sm:px-4">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{candidate.label}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={adding || !canGrant || unreachable}
          onClick={() => void addMachine()}
        >
          {adding ? <Spinner size="sm" /> : null}
          Add
        </Button>
      </div>
      {!canGrant ? (
        <p className="text-xs text-muted-foreground">
          Your session on {candidate.label} cannot pair other machines.
        </p>
      ) : unreachable ? (
        <p className="text-xs text-muted-foreground">
          This app reaches {candidate.label} at a local address that {environmentLabel} cannot use.
          Paste a pairing link from {candidate.label} with an address it can reach.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
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
    let result: AtomCommandResult<unknown, unknown>;
    try {
      result = await add({
        environmentId,
        input: {
          pairingUrl: trimmedUrl,
          ...(trimmedLabel.length > 0 ? { label: trimmedLabel } : {}),
        },
      });
    } finally {
      setAdding(false);
    }
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
