import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  SANDBOX_PROVIDER_KINDS,
  type CloudSandboxRecord,
  type EnvironmentId,
  type SandboxId,
  type SandboxProviderAvailability,
  type SandboxProviderKind,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import {
  CameraIcon,
  ClockIcon,
  CloudIcon,
  Link2Icon,
  MoonIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { requestConfirmDialog } from "~/confirmDialog";
import { useNowMinute } from "~/hooks/useNowMinute";
import { m as resolveMessage } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { sandboxEnvironment, useSandboxState } from "~/state/sandboxes";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildSandboxSpawnInput,
  formatSandboxAgentHarness,
  formatSandboxRuntimeDuration,
  getSandboxProviderAvailability,
  isVercelRuntimeWarningActive,
  resolveDefaultSandboxProvider,
  resolveSandboxRowActions,
  resolveSandboxStatusBadge,
  SANDBOX_AGENT_HARNESS_OPTIONS,
  SANDBOX_PROVIDER_META,
  sortCloudSandboxes,
} from "./CloudSandboxes.logic";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function formatCommandFailure(error: unknown, fallback: string): string {
  return error instanceof Error
    ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
    : fallback;
}

export function CloudSandboxesSection({
  environmentId,
  environmentLabel,
  connectedEnvironmentIds,
  externalLaunchOpen,
  onExternalLaunchOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly externalLaunchOpen?: boolean | undefined;
  readonly onExternalLaunchOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(nowMinute);

  const { state, loaded, error } = useSandboxState(environmentId);
  const canSpawn = useAtomValue(sandboxEnvironment.spawn.permissionAtom(environmentId));
  const canResume = useAtomValue(sandboxEnvironment.resume.permissionAtom(environmentId));
  const canSnapshot = useAtomValue(sandboxEnvironment.snapshot.permissionAtom(environmentId));
  const canStop = useAtomValue(sandboxEnvironment.stop.permissionAtom(environmentId));
  const canDestroy = useAtomValue(sandboxEnvironment.destroy.permissionAtom(environmentId));

  const spawnSandbox = useAtomCommand(sandboxEnvironment.spawn, { reportFailure: false });
  const resumeSandbox = useAtomCommand(sandboxEnvironment.resume, { reportFailure: false });
  const snapshotSandbox = useAtomCommand(sandboxEnvironment.snapshot, { reportFailure: false });
  const stopSandbox = useAtomCommand(sandboxEnvironment.stop, { reportFailure: false });
  const destroySandbox = useAtomCommand(sandboxEnvironment.destroy, { reportFailure: false });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });

  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const dialogOpen = externalLaunchOpen ?? internalDialogOpen;
  const setDialogOpen = (next: boolean) => {
    setInternalDialogOpen(next);
    onExternalLaunchOpenChange?.(next);
  };

  const [busySandboxAction, setBusySandboxAction] = useState<
    Readonly<Record<string, "wake" | "snapshot" | "sleep" | "destroy" | "connect">>
  >({});
  const [pendingPairingUrls, setPendingPairingUrls] = useState<ReadonlyMap<SandboxId, string>>(
    () => new Map(),
  );

  const setRowBusy = (
    id: SandboxId,
    action: "wake" | "snapshot" | "sleep" | "destroy" | "connect" | null,
  ) => {
    setBusySandboxAction((current) => {
      if (action === null) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: action };
    });
  };

  const rememberPairingUrl = (id: SandboxId, pairingUrl: string) => {
    setPendingPairingUrls((current) => {
      const next = new Map(current);
      next.set(id, pairingUrl);
      return next;
    });
  };

  const forgetPairingUrl = (id: SandboxId) => {
    setPendingPairingUrls((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  };

  const handleConnectPairingUrl = async (
    sandbox: Pick<CloudSandboxRecord, "id" | "name">,
    pairingUrl: string,
  ) => {
    setRowBusy(sandbox.id, "connect");
    const result = await connectPairing({ pairingUrl });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Success") {
      forgetPairingUrl(sandbox.id);
      toastManager.add({
        type: "success",
        title: gt("Cloud sandbox connected"),
        description: gt("{name} joined your KBCode environments.", { name: sandbox.name }),
      });
      return true;
    }

    if (!isAtomCommandInterrupted(result)) {
      const message = formatCommandFailure(
        squashAtomCommandFailure(result),
        gt("Could not connect to the cloud sandbox yet."),
      );
      rememberPairingUrl(sandbox.id, pairingUrl);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Sandbox ready: connect manually"),
          description: message,
        }),
      );
    }
    return false;
  };

  const handleWake = async (sandbox: CloudSandboxRecord) => {
    if (!canResume) return;
    setRowBusy(sandbox.id, "wake");
    const result = await resumeSandbox({ environmentId, input: { id: sandbox.id } });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not wake sandbox"),
            description: formatCommandFailure(
              squashAtomCommandFailure(result),
              gt("Failed to wake cloud sandbox."),
            ),
          }),
        );
      }
      return;
    }

    const { sandbox: resumed, pairingUrl } = result.value;
    if (pairingUrl) {
      rememberPairingUrl(resumed.id, pairingUrl);
      const alreadyConnected =
        resumed.environmentId !== null && connectedEnvironmentIds.has(resumed.environmentId);
      if (!alreadyConnected) {
        await handleConnectPairingUrl(resumed, pairingUrl);
        return;
      }
    }

    toastManager.add({
      type: "success",
      title: gt("Sandbox awake"),
      description: gt("{name} is ready.", { name: resumed.name }),
    });
  };

  const handleSnapshot = async (sandbox: CloudSandboxRecord) => {
    if (!canSnapshot) return;
    setRowBusy(sandbox.id, "snapshot");
    const result = await snapshotSandbox({ environmentId, input: { id: sandbox.id } });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not snapshot sandbox"),
            description: formatCommandFailure(
              squashAtomCommandFailure(result),
              gt("Failed to capture sandbox snapshot."),
            ),
          }),
        );
      }
      return;
    }

    toastManager.add({
      type: "success",
      title: gt("Snapshot saved"),
      description: gt("Saved snapshot {snapshotId}.", { snapshotId: result.value.snapshotId }),
    });
  };

  const handleSleep = async (sandbox: CloudSandboxRecord) => {
    if (!canStop) return;
    setRowBusy(sandbox.id, "sleep");
    const result = await stopSandbox({ environmentId, input: { id: sandbox.id } });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not sleep sandbox"),
            description: formatCommandFailure(
              squashAtomCommandFailure(result),
              gt("Failed to put sandbox to sleep."),
            ),
          }),
        );
      }
      return;
    }

    toastManager.add({
      type: "success",
      title: gt("Sandbox sleeping"),
      description: gt("{name} has been paused to preserve free-tier credits.", {
        name: sandbox.name,
      }),
    });
  };

  const handleDestroy = async (sandbox: CloudSandboxRecord) => {
    if (!canDestroy) return;
    const confirmed = await requestConfirmDialog(
      gt(
        "Destroy cloud sandbox {name}?\nUnsaved files outside a saved snapshot will be permanently deleted.",
        { name: sandbox.name },
      ),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;

    setRowBusy(sandbox.id, "destroy");
    const result = await destroySandbox({ environmentId, input: { id: sandbox.id } });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not destroy sandbox"),
            description: formatCommandFailure(
              squashAtomCommandFailure(result),
              gt("Failed to destroy cloud sandbox."),
            ),
          }),
        );
      }
      return;
    }

    forgetPairingUrl(sandbox.id);
    toastManager.add({
      type: "success",
      title: gt("Sandbox destroyed"),
      description: gt("{name} was permanently removed.", { name: sandbox.name }),
    });
  };

  const sortedSandboxes = sortCloudSandboxes(state.sandboxes);
  const sectionTitle =
    environmentLabel === null
      ? gt("Cloud Sandboxes")
      : gt("Cloud Sandboxes · {environment}", { environment: environmentLabel });

  return (
    <>
      <SettingsSection
        id="cloud-sandboxes"
        title={sectionTitle}
        icon={<CloudIcon aria-hidden className="size-4" />}
        headerAction={
          canSpawn ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              <PlusIcon className="size-3.5" />
              <T>New Cloud Sandbox</T>
            </Button>
          ) : null
        }
      >
        {error ? (
          <SettingsRow title={gt("Could not load cloud sandboxes")} description={error} />
        ) : !loaded ? (
          <SettingsRow title={gt("Loading cloud sandboxes…")} role="status" />
        ) : sortedSandboxes.length === 0 ? (
          <SettingsRow
            title={gt("No cloud sandboxes yet")}
            description={gt(
              "Launch an isolated cloud VM on CodeSandbox, Upstash Box, or Vercel Sandbox with automatic idle hibernation.",
            )}
            control={
              canSpawn ? (
                <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
                  <PlusIcon className="size-3.5" />
                  <T>New Cloud Sandbox</T>
                </Button>
              ) : undefined
            }
          />
        ) : (
          sortedSandboxes.map((sandbox) => {
            const busyAction = busySandboxAction[sandbox.id] ?? null;
            const actions = resolveSandboxRowActions(sandbox.state, busyAction !== null);
            const badge = resolveSandboxStatusBadge(sandbox.state, messages);
            const runtime = formatSandboxRuntimeDuration(sandbox, nowMs);
            const vercelWarning = isVercelRuntimeWarningActive(sandbox, nowMs);
            const harnessLabel = formatSandboxAgentHarness(sandbox.agentHarness, messages);
            const providerLabel = messages(SANDBOX_PROVIDER_META[sandbox.provider].label);
            const pairingUrl = pendingPairingUrls.get(sandbox.id) ?? null;
            const isConnected =
              sandbox.environmentId !== null && connectedEnvironmentIds.has(sandbox.environmentId);

            return (
              <div
                key={sandbox.id}
                className={cn(
                  ITEM_ROW_CLASSNAME,
                  "flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between",
                )}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {sandbox.name}
                    </span>
                    <Badge variant={badge.tone} size="sm">
                      {badge.label}
                    </Badge>
                    <Badge variant="outline" size="sm">
                      {providerLabel}
                    </Badge>
                    {isConnected ? (
                      <Badge variant="secondary" size="sm">
                        <T>Connected</T>
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {runtime ? (
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <ClockIcon aria-hidden className="size-3" />
                        {runtime}
                      </span>
                    ) : null}
                    <span>
                      {gt("{minutes}m idle timeout", { minutes: sandbox.idleTimeoutMinutes })}
                    </span>
                    {harnessLabel ? <span>{harnessLabel}</span> : null}
                    {sandbox.repoUrl ? (
                      <span className="max-w-72 truncate">
                        {sandbox.repoUrl}
                        {sandbox.branch ? ` (${sandbox.branch})` : ""}
                      </span>
                    ) : null}
                    {sandbox.snapshotId ? (
                      <span className="max-w-52 truncate">
                        {gt("Snapshot: {id}", { id: sandbox.snapshotId })}
                      </span>
                    ) : null}
                  </div>
                  {vercelWarning ? (
                    <p className="flex items-center gap-1 text-xs text-warning-foreground">
                      <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
                      <T>Approaching Vercel 45m continuous limit. Auto-snapshot imminent.</T>
                    </p>
                  ) : null}
                  {sandbox.lastError ? (
                    <p className="text-xs text-destructive">{sandbox.lastError}</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                  {pairingUrl && !isConnected ? (
                    <Button
                      type="button"
                      size="xs"
                      disabled={busyAction !== null}
                      onClick={() => void handleConnectPairingUrl(sandbox, pairingUrl)}
                    >
                      {busyAction === "connect" ? (
                        <Spinner size="sm" />
                      ) : (
                        <Link2Icon className="size-3" />
                      )}
                      <T>Connect</T>
                    </Button>
                  ) : null}
                  {canResume && actions.canWake ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={() => void handleWake(sandbox)}
                    >
                      {busyAction === "wake" ? (
                        <Spinner size="sm" />
                      ) : (
                        <PlayIcon className="size-3" />
                      )}
                      <T>Wake</T>
                    </Button>
                  ) : null}
                  {canSnapshot && actions.canSnapshot ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={() => void handleSnapshot(sandbox)}
                    >
                      {busyAction === "snapshot" ? (
                        <Spinner size="sm" />
                      ) : (
                        <CameraIcon className="size-3" />
                      )}
                      <T>Snapshot</T>
                    </Button>
                  ) : null}
                  {canStop && actions.canSleep ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null}
                      onClick={() => void handleSleep(sandbox)}
                    >
                      {busyAction === "sleep" ? (
                        <Spinner size="sm" />
                      ) : (
                        <MoonIcon className="size-3" />
                      )}
                      <T>Sleep</T>
                    </Button>
                  ) : null}
                  {canDestroy && actions.canDestroy ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      disabled={busyAction !== null}
                      onClick={() => void handleDestroy(sandbox)}
                      aria-label={gt("Destroy {name}", { name: sandbox.name })}
                    >
                      {busyAction === "destroy" ? (
                        <Spinner size="sm" />
                      ) : (
                        <Trash2Icon className="size-3 text-destructive" />
                      )}
                      <span className="text-destructive">
                        <T>Destroy</T>
                      </span>
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      {canSpawn && dialogOpen ? (
        <NewCloudSandboxDialog
          open
          onOpenChange={setDialogOpen}
          providers={state.providers}
          defaultIdleTimeoutMinutes={state.defaultIdleTimeoutMinutes}
          onSpawn={async (input) => {
            const result = await spawnSandbox({ environmentId, input });
            if (result._tag === "Failure") {
              if (isAtomCommandInterrupted(result)) return { ok: false as const, error: null };
              return {
                ok: false as const,
                error: formatCommandFailure(
                  squashAtomCommandFailure(result),
                  gt("Failed to launch cloud sandbox."),
                ),
              };
            }
            const { sandbox, pairingUrl } = result.value;
            setDialogOpen(false);
            if (pairingUrl) {
              rememberPairingUrl(sandbox.id, pairingUrl);
              void handleConnectPairingUrl(sandbox, pairingUrl);
            } else {
              toastManager.add({
                type: "success",
                title: gt("Cloud sandbox launched"),
                description: gt("{name} is ready.", { name: sandbox.name }),
              });
            }
            return { ok: true as const };
          }}
        />
      ) : null}
    </>
  );
}

function NewCloudSandboxDialog({
  open,
  onOpenChange,
  providers,
  defaultIdleTimeoutMinutes,
  onSpawn,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providers: ReadonlyArray<SandboxProviderAvailability>;
  readonly defaultIdleTimeoutMinutes: number;
  readonly onSpawn: (
    input: Parameters<typeof sandboxEnvironment.spawn.run>[1]["input"],
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string | null }>;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [provider, setProvider] = useState<SandboxProviderKind>(() =>
    resolveDefaultSandboxProvider(providers),
  );
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [agentHarness, setAgentHarness] = useState("primeAgent");
  const [snapshotId, setSnapshotId] = useState("");
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(String(defaultIdleTimeoutMinutes));
  const [error, setError] = useState<string | null>(null);
  const [isSpawning, setIsSpawning] = useState(false);

  const selectedAvailability = getSandboxProviderAvailability(providers, provider);
  const anyConfigured = providers.length === 0 || providers.some((entry) => entry.configured);

  const handleOpenChange = (nextOpen: boolean) => {
    if (isSpawning) return;
    if (nextOpen) {
      setProvider(resolveDefaultSandboxProvider(providers));
      setIdleTimeoutMinutes(String(defaultIdleTimeoutMinutes));
      setError(null);
    } else {
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    const built = buildSandboxSpawnInput(
      {
        provider,
        name,
        repoUrl,
        branch,
        agentHarness,
        snapshotId,
        idleTimeoutMinutes,
      },
      { providers, defaultIdleTimeoutMinutes },
      messages,
    );
    if (!built.ok) {
      setError(built.error);
      return;
    }

    setError(null);
    setIsSpawning(true);
    const outcome = await onSpawn(built.input);
    setIsSpawning(false);
    if (!outcome.ok && outcome.error) {
      setError(outcome.error);
      return;
    }
    if (outcome.ok) {
      setName("");
      setRepoUrl("");
      setBranch("");
      setSnapshotId("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>New Cloud Sandbox</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Boot an isolated cloud VM running KBCode headless and connect it directly to your
              environment switcher.
            </T>
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-4">
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                <T>Provider</T>
              </span>
              <div className="grid gap-2">
                {SANDBOX_PROVIDER_KINDS.map((kind) => {
                  const meta = SANDBOX_PROVIDER_META[kind];
                  const availability = getSandboxProviderAvailability(providers, kind);
                  const isSelected = provider === kind;
                  const isConfigured = providers.length === 0 || availability.configured;
                  return (
                    <button
                      key={kind}
                      type="button"
                      disabled={isSpawning}
                      onClick={() => {
                        setProvider(kind);
                        setError(null);
                      }}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "border-border/80 bg-background hover:bg-muted/40",
                        !isConfigured && "opacity-70",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {messages(meta.label)}
                        </span>
                        {!isConfigured ? (
                          <Badge variant="outline" size="sm">
                            <T>Not configured</T>
                          </Badge>
                        ) : availability.defaultSnapshotId ? (
                          <Badge variant="secondary" size="sm">
                            <T>Base snapshot</T>
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {messages(meta.freeTierHint)}
                      </span>
                      {!isConfigured && availability.reason ? (
                        <span className="text-xs text-destructive">{availability.reason}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {!anyConfigured ? (
                <p className="text-xs text-muted-foreground">
                  <T>
                    Configure CODESANDBOX_API_KEY, UPSTASH_BOX_API_KEY, or VERCEL_TOKEN on your host
                    server to enable launching sandboxes.
                  </T>
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 sm:col-span-2">
                <span className="text-sm font-medium text-foreground">
                  <T>Repository URL</T>{" "}
                  <span className="font-normal text-muted-foreground">
                    <T>(optional)</T>
                  </span>
                </span>
                <Input
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  disabled={isSpawning}
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-foreground">
                  <T>Branch</T>{" "}
                  <span className="font-normal text-muted-foreground">
                    <T>(optional)</T>
                  </span>
                </span>
                <Input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="main"
                  disabled={isSpawning}
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-foreground">
                  <T>Sandbox name</T>{" "}
                  <span className="font-normal text-muted-foreground">
                    <T>(optional)</T>
                  </span>
                </span>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="feature-box"
                  disabled={isSpawning}
                />
              </label>

              <div className="space-y-1.5">
                <span className="block text-sm font-medium text-foreground">
                  <T>Default agent harness</T>
                </span>
                <Select
                  value={agentHarness}
                  onValueChange={(next) => {
                    if (typeof next === "string") setAgentHarness(next);
                  }}
                >
                  <SelectTrigger className="w-full" disabled={isSpawning}>
                    <SelectValue>
                      {formatSandboxAgentHarness(agentHarness, messages) ?? gt("Select harness")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {SANDBOX_AGENT_HARNESS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {messages(option.label)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-foreground">
                  <T>Auto-hibernate (minutes)</T>
                </span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  step={1}
                  value={idleTimeoutMinutes}
                  onChange={(event) => setIdleTimeoutMinutes(event.target.value)}
                  disabled={isSpawning}
                />
              </label>

              <label className="block space-y-1.5 sm:col-span-2">
                <span className="text-sm font-medium text-foreground">
                  <T>Snapshot / base image</T>{" "}
                  <span className="font-normal text-muted-foreground">
                    <T>(optional)</T>
                  </span>
                </span>
                <Input
                  value={snapshotId}
                  onChange={(event) => setSnapshotId(event.target.value)}
                  placeholder={
                    selectedAvailability.defaultSnapshotId ?? gt("Saved snapshot ID (optional)")
                  }
                  disabled={isSpawning}
                />
              </label>
            </div>
          </div>
        </DialogPanel>

        <DialogFooter>
          <DialogClose
            disabled={isSpawning}
            render={<Button variant="outline" disabled={isSpawning} />}
          >
            <T>Cancel</T>
          </DialogClose>
          <Button
            type="button"
            disabled={isSpawning || (providers.length > 0 && !selectedAvailability.configured)}
            onClick={() => void handleSubmit()}
          >
            {isSpawning ? (
              <>
                <Spinner size="sm" />
                <T>Launching…</T>
              </>
            ) : (
              <T>Launch Cloud Sandbox</T>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
