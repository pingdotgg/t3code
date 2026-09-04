import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  FEDERATION_DEFAULT_SCOPES,
  type FederationArtifactFetchResponse,
  type FederationArtifactRef,
  type FederationPeer,
  type FederationPeerCodeResult,
  type FederationProjectSummary,
  type FederationRemoteRun,
  type FederationScope,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { CopyIcon, PlayIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatExpiresInLabel } from "../../timestampFormat";
import { federationEnvironment } from "~/state/federation";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  FEDERATION_SCOPE_OPTIONS,
  describeFederationPeerCode,
  formatFederationTimestamp,
  isRemoteRunActive,
  peerStatusDotClassName,
  peerStatusLabel,
  remoteRunLastEventSummary,
  remoteRunStatusBadgeVariant,
  remoteRunStatusLabel,
  sortRemoteRuns,
  toggleFederationScope,
} from "./FederationSection.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_REMOTE_RUNS: ReadonlyArray<FederationRemoteRun> = [];
const EMPTY_PEERS: ReadonlyArray<FederationPeer> = [];

const RUNTIME_MODE_OPTIONS: ReadonlyArray<{ readonly value: RuntimeMode; readonly label: string }> =
  [
    { value: "approval-required", label: "Approval required" },
    { value: "auto-accept-edits", label: "Auto-accept edits" },
    { value: "auto", label: "Auto" },
    { value: "full-access", label: "Full access" },
  ];

const PEER_DEFAULT_RUNTIME_MODE = "peer-default";

function commandFailureMessage(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function ScopeChecklist({
  scopes,
  disabled,
  heading,
  onToggle,
}: {
  readonly scopes: ReadonlyArray<FederationScope>;
  readonly disabled: boolean;
  readonly heading: string;
  readonly onToggle: (scope: FederationScope, checked: boolean) => void;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-foreground">{heading}</h3>
      <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
        {FEDERATION_SCOPE_OPTIONS.map(({ scope, title, description }) => (
          <label
            key={scope}
            className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
          >
            <Checkbox
              className="mt-0.5"
              checked={scopes.includes(scope)}
              disabled={disabled}
              onCheckedChange={(checked) => onToggle(scope, checked === true)}
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">
                {title} <code className="font-mono text-muted-foreground">{scope}</code>
              </span>
              <span className="block text-xs leading-snug text-muted-foreground">
                {description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function ScopeChips({
  label,
  scopes,
}: {
  readonly label: string;
  readonly scopes: ReadonlyArray<FederationScope>;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {scopes.length === 0 ? (
        <span className="text-[11px] text-muted-foreground/70">none</span>
      ) : (
        scopes.map((scope) => (
          <Badge key={scope} variant="outline" size="sm" className="font-mono">
            {scope}
          </Badge>
        ))
      )}
    </span>
  );
}

/** The minted peer code with QR and a countdown; ticks only while shown. */
const PeerCodeReveal = memo(function PeerCodeReveal({
  issued,
}: {
  readonly issued: FederationPeerCodeResult;
}) {
  const nowMs = useRelativeTimeTick(1_000);
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Peer code copied",
        description: "Add it on the other environment under Federation → Add peer.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy peer code",
          description: error.message,
        }),
      );
    },
  });
  const expired = Date.parse(issued.expiresAt) <= nowMs;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <Textarea
            readOnly
            value={issued.code}
            rows={4}
            aria-label="Federation peer code"
            className="font-mono text-[11px] leading-relaxed break-all"
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => copyToClipboard(issued.code)}>
              <CopyIcon aria-hidden />
              Copy code
            </Button>
            <span
              className={
                expired ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"
              }
            >
              {formatExpiresInLabel(issued.expiresAt, nowMs)} · single use
            </span>
          </div>
        </div>
        {expired ? null : (
          <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
            <QRCodeSvg value={issued.code} size={168} level="L" marginSize={1} title="Peer code" />
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground/70">
        Offers the redeeming environment: {issued.payload.scopes.join(", ")}.
      </p>
    </div>
  );
});

const CreatePeerCodeDialog = memo(function CreatePeerCodeDialog({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState<ReadonlyArray<FederationScope>>(FEDERATION_DEFAULT_SCOPES);
  const [issued, setIssued] = useState<FederationPeerCodeResult | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createPeerCode = useAtomCommand(federationEnvironment.createPeerCode, {
    reportFailure: false,
  });

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    const result = await createPeerCode({ environmentId, input: { scopes } });
    setIsCreating(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandFailureMessage(result, "Could not create a peer code."));
      }
      return;
    }
    setIssued(result.value);
  }, [createPeerCode, environmentId, scopes]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setIssued(null);
          setError(null);
          setScopes(FEDERATION_DEFAULT_SCOPES);
        }
      }}
    >
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        Create peer code
      </DialogTrigger>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create peer code</DialogTitle>
          <DialogDescription>
            A one-time code another T3 environment adds under Federation → Add peer. The scopes you
            tick are what that environment may do here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {issued === null ? (
            <ScopeChecklist
              heading="Offer the peer"
              scopes={scopes}
              disabled={isCreating}
              onToggle={(scope, checked) =>
                setScopes((current) => toggleFederationScope(current, scope, checked))
              }
            />
          ) : (
            <PeerCodeReveal issued={issued} />
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {issued === null ? "Cancel" : "Done"}
          </Button>
          {issued === null ? (
            <Button
              disabled={isCreating || scopes.length === 0}
              onClick={() => void handleCreate()}
            >
              {isCreating ? "Creating…" : "Create code"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});

const AddPeerDialog = memo(function AddPeerDialog({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [grantedScopes, setGrantedScopes] =
    useState<ReadonlyArray<FederationScope>>(FEDERATION_DEFAULT_SCOPES);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Captured when the code is typed or pasted; expiry is judged as of that
  // moment and the server re-checks it when the peer is added.
  const [codeEnteredAtMs, setCodeEnteredAtMs] = useState(0);
  const addPeer = useAtomCommand(federationEnvironment.addPeer, { reportFailure: false });
  const preview = useMemo(
    () => describeFederationPeerCode(code, codeEnteredAtMs),
    [code, codeEnteredAtMs],
  );
  const canAdd = !isAdding && preview.kind === "valid" && !preview.expired;

  const handleAdd = useCallback(async () => {
    if (!canAdd) return;
    setIsAdding(true);
    setError(null);
    const result = await addPeer({ environmentId, input: { code: code.trim(), grantedScopes } });
    setIsAdding(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandFailureMessage(result, "Could not add the peer."));
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: "Peer added",
      description: `${result.value.label} can now coordinate with this environment.`,
    });
    setOpen(false);
    setCode("");
    setGrantedScopes(FEDERATION_DEFAULT_SCOPES);
  }, [addPeer, canAdd, code, environmentId, grantedScopes]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setCode("");
          setGrantedScopes(FEDERATION_DEFAULT_SCOPES);
        }
      }}
    >
      <DialogTrigger render={<Button size="xs" variant="default" />}>
        <PlusIcon className="size-3" />
        Add peer
      </DialogTrigger>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add peer</DialogTitle>
          <DialogDescription>
            Paste a peer code created on the other environment. Both sides keep their own grants:
            the code carries what the peer offers you; tick what you grant it here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Peer code</span>
            <Textarea
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setCodeEnteredAtMs(Date.now());
                setError(null);
              }}
              placeholder="t3c://peer/…"
              rows={3}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={isAdding}
              className="font-mono text-xs leading-relaxed break-all"
            />
          </label>
          {preview.kind === "valid" ? (
            <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
              <p className="font-medium text-foreground">{preview.payload.label}</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {preview.payload.environmentId} · protocol v{preview.payload.protocolVersion}
              </p>
              <ScopeChips label="Offers you" scopes={preview.payload.scopes} />
              {preview.expired ? (
                <p className="text-destructive">
                  This peer code has expired. Create a fresh one on the other environment.
                </p>
              ) : null}
            </div>
          ) : preview.kind === "invalid" || preview.kind === "tailcat-code" ? (
            <p className="text-xs text-destructive">{preview.message}</p>
          ) : null}
          <ScopeChecklist
            heading="Grant the peer"
            scopes={grantedScopes}
            disabled={isAdding}
            onToggle={(scope, checked) =>
              setGrantedScopes((current) => toggleFederationScope(current, scope, checked))
            }
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={isAdding} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!canAdd} onClick={() => void handleAdd()}>
            {isAdding ? "Adding…" : "Add peer"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});

type PeerRowProps = {
  readonly peer: FederationPeer;
  readonly refreshing: boolean;
  readonly onRefresh: (peer: FederationPeer) => void;
  readonly onRemove: (peer: FederationPeer) => void;
};

const PeerRow = memo(function PeerRow({ peer, refreshing, onRefresh, onRemove }: PeerRowProps) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={peerStatusLabel(peer.status)}
              dotClassName={peerStatusDotClassName(peer.status)}
            />
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{peer.label}</h3>
            {peer.remoteServerVersion ? (
              <span className="rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-[10px] text-muted-foreground/80">
                t3@{peer.remoteServerVersion}
              </span>
            ) : null}
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {peer.publicKeyFingerprint} · {peer.peerId}
          </p>
          <div className="flex flex-col gap-1">
            <ScopeChips label="Granted" scopes={peer.grantedScopes} />
            <ScopeChips label="Allowed" scopes={peer.allowedScopes} />
          </div>
          <p className="text-xs text-muted-foreground">
            {peer.lastSeenAt
              ? `Last seen ${formatFederationTimestamp(peer.lastSeenAt)}`
              : "Not reached yet"}
            {peer.transport ? " · via Tailcat" : " · no transport"}
          </p>
          {peer.lastError ? <p className="text-xs text-destructive">{peer.lastError}</p> : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button size="xs" variant="outline" disabled={refreshing} onClick={() => onRefresh(peer)}>
            <RefreshCwIcon aria-hidden />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button size="xs" variant="destructive-outline" onClick={() => onRemove(peer)}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
});

const RemoteRunChangesDialog = memo(function RemoteRunChangesDialog({
  environmentId,
  remoteRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly remoteRun: FederationRemoteRun;
}) {
  const [open, setOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<ReadonlyArray<FederationArtifactRef> | null>(null);
  const [isDescribing, setIsDescribing] = useState(false);
  const [fetched, setFetched] = useState<FederationArtifactFetchResponse | null>(null);
  const [fetchingTurnId, setFetchingTurnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const describeRemoteArtifacts = useAtomCommand(federationEnvironment.describeRemoteArtifacts, {
    reportFailure: false,
  });
  const fetchRemoteArtifact = useAtomCommand(federationEnvironment.fetchRemoteArtifact, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({ type: "success", title: "Diff copied" });
    },
    onError: (copyError) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy diff",
          description: copyError.message,
        }),
      );
    },
  });
  const { peerId, peerLabel } = remoteRun;
  const { threadId } = remoteRun.run;

  const loadArtifacts = useCallback(async () => {
    setIsDescribing(true);
    setError(null);
    const result = await describeRemoteArtifacts({ environmentId, input: { peerId, threadId } });
    setIsDescribing(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandFailureMessage(result, "Could not list the changes."));
      }
      return;
    }
    setArtifacts(result.value.artifacts);
  }, [describeRemoteArtifacts, environmentId, peerId, threadId]);

  const loadDiff = useCallback(
    async (artifact: FederationArtifactRef) => {
      setFetchingTurnId(artifact.turnId);
      setError(null);
      const result = await fetchRemoteArtifact({
        environmentId,
        input: { peerId, threadId: artifact.threadId, turnId: artifact.turnId },
      });
      setFetchingTurnId(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setError(commandFailureMessage(result, "Could not fetch the diff."));
        }
        return;
      }
      setFetched(result.value);
    },
    [environmentId, fetchRemoteArtifact, peerId],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void loadArtifacts();
        } else {
          setArtifacts(null);
          setFetched(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button size="xs" variant="outline" />}>View changes</DialogTrigger>
      <DialogPopup className="max-h-[85dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{remoteRun.run.title}</DialogTitle>
          <DialogDescription>
            Runs on <span className="font-medium text-foreground">{peerLabel}</span> · origin{" "}
            <code className="font-mono">{remoteRun.run.environmentId}</code>. Changes are read here,
            never applied to this machine.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {artifacts === null ? (
            <p className="text-xs text-muted-foreground">
              {isDescribing ? "Listing changes…" : "No change list yet."}
            </p>
          ) : artifacts.length === 0 ? (
            <p className="text-xs text-muted-foreground">This run has produced no changes yet.</p>
          ) : (
            <div className="space-y-2">
              {artifacts.map((artifact) => {
                const isSelected = fetched?.ref.turnId === artifact.turnId;
                return (
                  <div
                    key={artifact.turnId}
                    className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium text-foreground">
                          Turn diff · turns {artifact.fromTurnCount} → {artifact.toTurnCount} ·{" "}
                          {artifact.files.length === 1
                            ? "1 file"
                            : `${artifact.files.length} files`}
                        </p>
                        <p className="truncate text-muted-foreground">
                          Runs on {peerLabel} · origin{" "}
                          <code className="font-mono">{artifact.environmentId}</code>
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant={isSelected ? "default" : "outline"}
                        disabled={fetchingTurnId !== null}
                        onClick={() => void loadDiff(artifact)}
                      >
                        {fetchingTurnId === artifact.turnId
                          ? "Fetching…"
                          : isSelected
                            ? "Refetch diff"
                            : "Show diff"}
                      </Button>
                    </div>
                    {artifact.files.length > 0 ? (
                      <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                        {artifact.files.map((file) => (
                          <li key={file.path} className="truncate">
                            <span className="text-foreground/70">{file.status}</span> {file.path}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {fetched !== null ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  Diff from {peerLabel} · origin{" "}
                  <code className="font-mono">{fetched.ref.environmentId}</code> · fetched{" "}
                  {formatFederationTimestamp(fetched.fetchedAt)}
                </span>
                <Button size="xs" variant="ghost" onClick={() => copyToClipboard(fetched.diff)}>
                  <CopyIcon aria-hidden />
                  Copy diff
                </Button>
              </div>
              <pre className="max-h-[40dvh] overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground/85">
                {fetched.diff.length > 0 ? fetched.diff : "(empty diff)"}
              </pre>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});

type RemoteRunRowProps = {
  readonly environmentId: EnvironmentId;
  readonly remoteRun: FederationRemoteRun;
  readonly cancelling: boolean;
  readonly onCancel: (remoteRun: FederationRemoteRun) => void;
};

const RemoteRunRow = memo(function RemoteRunRow({
  environmentId,
  remoteRun,
  cancelling,
  onCancel,
}: RemoteRunRowProps) {
  const { run } = remoteRun;
  const summary = remoteRunLastEventSummary(remoteRun);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <Badge variant={remoteRunStatusBadgeVariant(run.status)} size="sm">
              {remoteRunStatusLabel(run.status)}
            </Badge>
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{run.title}</h3>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            Runs on <span className="font-medium text-foreground">{remoteRun.peerLabel}</span> ·
            origin <code className="font-mono">{run.environmentId}</code> · project{" "}
            <code className="font-mono">{run.projectId}</code>
          </p>
          {summary ? <p className="truncate text-xs text-muted-foreground">{summary}</p> : null}
          {remoteRun.syncError ? (
            <p className="text-xs text-destructive">{remoteRun.syncError}</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground/70">
            Requested {formatFederationTimestamp(run.requestedAt)}
            {run.completedAt ? ` · finished ${formatFederationTimestamp(run.completedAt)}` : ""}
            {run.turnCount > 0
              ? ` · ${run.turnCount === 1 ? "1 turn" : `${run.turnCount} turns`}`
              : ""}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {isRemoteRunActive(run.status) ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={cancelling}
              onClick={() => onCancel(remoteRun)}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
          <RemoteRunChangesDialog environmentId={environmentId} remoteRun={remoteRun} />
        </div>
      </div>
    </div>
  );
});

const RunOnPeerDialog = memo(function RunOnPeerDialog({
  environmentId,
  peers,
}: {
  readonly environmentId: EnvironmentId;
  readonly peers: ReadonlyArray<FederationPeer>;
}) {
  const [open, setOpen] = useState(false);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<string>(PEER_DEFAULT_RUNTIME_MODE);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startRemoteRun = useAtomCommand(federationEnvironment.startRemoteRun, {
    reportFailure: false,
  });
  const selectedPeer = peers.find((peer) => peer.peerId === selectedPeerId) ?? null;
  const projectsQuery = useEnvironmentQuery(
    open && selectedPeer !== null
      ? federationEnvironment.remoteProjects({
          environmentId,
          input: { peerId: selectedPeer.peerId },
        })
      : null,
  );
  const projects: ReadonlyArray<FederationProjectSummary> = projectsQuery.data?.projects ?? [];
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const peerAllowsStart = selectedPeer?.allowedScopes.includes("runs.start") ?? false;
  const canStart =
    !isStarting &&
    selectedPeer !== null &&
    selectedProject !== null &&
    prompt.trim().length > 0 &&
    peerAllowsStart;

  const reset = useCallback(() => {
    setSelectedPeerId(null);
    setSelectedProjectId(null);
    setPrompt("");
    setRuntimeMode(PEER_DEFAULT_RUNTIME_MODE);
    setError(null);
  }, []);

  const handleStart = useCallback(async () => {
    if (!canStart || selectedPeer === null || selectedProject === null) return;
    setIsStarting(true);
    setError(null);
    const selectedRuntimeMode = RUNTIME_MODE_OPTIONS.find(
      (option) => option.value === runtimeMode,
    )?.value;
    const result = await startRemoteRun({
      environmentId,
      input: {
        peerId: selectedPeer.peerId,
        projectId: selectedProject.id,
        prompt: prompt.trim(),
        ...(selectedRuntimeMode === undefined ? {} : { runtimeMode: selectedRuntimeMode }),
      },
    });
    setIsStarting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandFailureMessage(result, "Could not start the run."));
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: `Run started on ${selectedPeer.label}`,
      description: `${result.value.run.title} executes on ${selectedPeer.label}; follow it under Remote runs.`,
    });
    setOpen(false);
    reset();
  }, [
    canStart,
    environmentId,
    prompt,
    reset,
    runtimeMode,
    selectedPeer,
    selectedProject,
    startRemoteRun,
  ]);

  const runtimeModeLabel =
    RUNTIME_MODE_OPTIONS.find((option) => option.value === runtimeMode)?.label ?? "Peer default";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" disabled={peers.length === 0} />}>
        <PlayIcon aria-hidden />
        Run on peer
      </DialogTrigger>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run on peer</DialogTitle>
          <DialogDescription>
            The agent runs on the peer, in that environment's project and with its providers. This
            environment only follows the run and can fetch its changes.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Peer</span>
            <Select
              value={selectedPeerId}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                setSelectedPeerId(value);
                setSelectedProjectId(null);
                setError(null);
              }}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Peer" disabled={isStarting}>
                <SelectValue>{selectedPeer?.label ?? "Choose a peer"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {peers.map((peer) => (
                  <SelectItem hideIndicator key={peer.peerId} value={peer.peerId}>
                    {peer.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {selectedPeer !== null && !peerAllowsStart ? (
              <p className="mt-1.5 text-xs text-destructive">
                {selectedPeer.label} has not granted this environment the runs.start scope.
              </p>
            ) : null}
          </div>
          <div className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Project on {selectedPeer?.label ?? "the peer"}
            </span>
            <Select
              value={selectedProjectId}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                setSelectedProjectId(value);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label="Project"
                disabled={isStarting || selectedPeer === null || projects.length === 0}
              >
                <SelectValue>
                  {selectedProject?.title ??
                    (selectedPeer === null
                      ? "Choose a peer first"
                      : projectsQuery.isPending && projectsQuery.data === null
                        ? "Loading projects…"
                        : projects.length === 0
                          ? "No projects available"
                          : "Choose a project")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {projects.map((project) => (
                  <SelectItem hideIndicator key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {projectsQuery.error ? (
              <p className="mt-1.5 text-xs text-destructive">{projectsQuery.error}</p>
            ) : selectedProject ? (
              <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
                {selectedProject.workspaceRoot}
              </p>
            ) : null}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Prompt</span>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What should the agent do on the peer?"
              rows={4}
              disabled={isStarting}
            />
          </label>
          <div className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Runtime mode</span>
            <Select
              value={runtimeMode}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                setRuntimeMode(value);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label="Runtime mode"
                disabled={isStarting}
              >
                <SelectValue>{runtimeModeLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={PEER_DEFAULT_RUNTIME_MODE}>
                  Peer default
                </SelectItem>
                {RUNTIME_MODE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={isStarting} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!canStart} onClick={() => void handleStart()}>
            <PlayIcon aria-hidden />
            {isStarting ? "Starting…" : `Start on ${selectedPeer?.label ?? "peer"}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});

type FederationSectionProps = {
  readonly environmentId: EnvironmentId;
};

/**
 * Settings → Connections → Federation: this environment's federation identity,
 * its peers with the scopes each side granted, the runs it started on peers,
 * and the "Run on peer" entry point. Shown only when the server advertises the
 * federation capability.
 */
export const FederationSection = memo(function FederationSection({
  environmentId,
}: FederationSectionProps) {
  const peersQuery = useEnvironmentQuery(federationEnvironment.peers({ environmentId, input: {} }));
  const runsQuery = useEnvironmentQuery(
    federationEnvironment.remoteRuns({ environmentId, input: {} }),
  );
  const snapshot = peersQuery.data;
  const peers = snapshot?.peers ?? EMPTY_PEERS;
  const runs = useMemo(
    () => sortRemoteRuns(runsQuery.data?.runs ?? EMPTY_REMOTE_RUNS),
    [runsQuery.data],
  );
  const refreshPeer = useAtomCommand(federationEnvironment.refreshPeer, { reportFailure: false });
  const removePeer = useAtomCommand(federationEnvironment.removePeer, { reportFailure: false });
  const cancelRemoteRun = useAtomCommand(federationEnvironment.cancelRemoteRun, {
    reportFailure: false,
  });
  const [refreshingPeerId, setRefreshingPeerId] = useState<string | null>(null);
  const [pendingRemovePeer, setPendingRemovePeer] = useState<FederationPeer | null>(null);
  const [isRemovingPeer, setIsRemovingPeer] = useState(false);
  const [cancellingThreadId, setCancellingThreadId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const reportFailure = useCallback(
    (result: AtomCommandResult<unknown, unknown>, title: string, fallback: string) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const message = commandFailureMessage(result, fallback);
      setMutationError(message);
      toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
    },
    [],
  );

  const handleRefreshPeer = useCallback(
    async (peer: FederationPeer) => {
      setRefreshingPeerId(peer.peerId);
      setMutationError(null);
      const result = await refreshPeer({ environmentId, input: { peerId: peer.peerId } });
      setRefreshingPeerId(null);
      reportFailure(result, `Could not reach ${peer.label}`, "The peer did not answer.");
    },
    [environmentId, refreshPeer, reportFailure],
  );

  const handleConfirmRemovePeer = useCallback(async () => {
    if (pendingRemovePeer === null) return;
    setIsRemovingPeer(true);
    setMutationError(null);
    const result = await removePeer({
      environmentId,
      input: { peerId: pendingRemovePeer.peerId },
    });
    setIsRemovingPeer(false);
    setPendingRemovePeer(null);
    reportFailure(result, "Could not remove peer", "The peer could not be removed.");
  }, [environmentId, pendingRemovePeer, removePeer, reportFailure]);

  const handleCancelRun = useCallback(
    async (remoteRun: FederationRemoteRun) => {
      setCancellingThreadId(remoteRun.run.threadId);
      setMutationError(null);
      const result = await cancelRemoteRun({
        environmentId,
        input: { peerId: remoteRun.peerId, threadId: remoteRun.run.threadId },
      });
      setCancellingThreadId(null);
      reportFailure(
        result,
        `Could not cancel on ${remoteRun.peerLabel}`,
        "The peer did not accept the cancel.",
      );
    },
    [cancelRemoteRun, environmentId, reportFailure],
  );

  return (
    <SettingsSection
      {...searchableSetting("federation")}
      headerAction={
        <div className="flex items-center gap-2">
          <CreatePeerCodeDialog environmentId={environmentId} />
          <AddPeerDialog environmentId={environmentId} />
        </div>
      }
    >
      <SettingsRow
        title="This environment"
        description={
          snapshot ? (
            <>
              Identity{" "}
              <code className="font-mono text-foreground/80">{snapshot.publicKeyFingerprint}</code>{" "}
              · protocol v{snapshot.protocolVersion}. Peers verify this fingerprint; share it out of
              band when in doubt.
            </>
          ) : (
            (peersQuery.error ?? "Loading federation state…")
          )
        }
        status={
          mutationError ? <span className="block text-destructive">{mutationError}</span> : null
        }
      />
      <SettingsRow
        {...searchableSetting("federation-peers")}
        description="Environments this one coordinates with. Each side grants the other explicit scopes; nothing is shared implicitly."
      >
        <div className="-mx-3 mt-2 space-y-1 sm:-mx-4">
          {peers.length === 0 ? (
            <div className={ITEM_ROW_CLASSNAME}>
              <p className="text-xs text-muted-foreground/60">
                No peers yet. Create a peer code here and add it on the other environment, or add a
                code it created.
              </p>
            </div>
          ) : (
            peers.map((peer) => (
              <PeerRow
                key={peer.peerId}
                peer={peer}
                refreshing={refreshingPeerId === peer.peerId}
                onRefresh={(target) => void handleRefreshPeer(target)}
                onRemove={setPendingRemovePeer}
              />
            ))
          )}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Remote runs"
        description="Runs this environment started on a peer. They execute on the peer; this list follows their status and changes."
        control={<RunOnPeerDialog environmentId={environmentId} peers={peers} />}
      >
        <div className="-mx-3 mt-2 space-y-1 sm:-mx-4">
          {runsQuery.error ? (
            <div className={ITEM_ROW_CLASSNAME}>
              <p className="text-xs text-destructive">{runsQuery.error}</p>
            </div>
          ) : runs.length === 0 ? (
            <div className={ITEM_ROW_CLASSNAME}>
              <p className="text-xs text-muted-foreground/60">
                {runsQuery.data === null
                  ? "Loading remote runs…"
                  : "No remote runs yet. Use Run on peer to start one."}
              </p>
            </div>
          ) : (
            runs.map((remoteRun) => (
              <RemoteRunRow
                key={`${remoteRun.peerId}:${remoteRun.run.threadId}`}
                environmentId={environmentId}
                remoteRun={remoteRun}
                cancelling={cancellingThreadId === remoteRun.run.threadId}
                onCancel={(target) => void handleCancelRun(target)}
              />
            ))
          )}
        </div>
      </SettingsRow>
      <AlertDialog
        open={pendingRemovePeer !== null}
        onOpenChange={(open) => {
          if (isRemovingPeer) return;
          if (!open) setPendingRemovePeer(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRemovePeer?.label ?? "peer"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This environment stops accepting federation calls from it and can no longer start or
              follow runs there. Runs already executing on the peer keep running there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isRemovingPeer}
              render={<Button variant="outline" disabled={isRemovingPeer} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isRemovingPeer}
              onClick={() => void handleConfirmRemovePeer()}
            >
              {isRemovingPeer ? "Removing…" : "Remove peer"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
});
