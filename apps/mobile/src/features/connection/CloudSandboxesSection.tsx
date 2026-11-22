import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useFocusEffect } from "@react-navigation/native";
import {
  SANDBOX_PROVIDER_KINDS,
  type CloudSandboxRecord,
  type EnvironmentId,
  type SandboxId,
  type SandboxProviderAvailability,
  type SandboxProviderKind,
  type SandboxSpawnInput,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useCallback, useState } from "react";
import { AppState, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Sheet } from "../../components/ui/Sheet";
import { connectPairingUrl as connectPairingUrlAtom } from "../../connection/onboarding";
import { m as resolveMessage } from "../../i18n/messages";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig } from "../../state/entities";
import { sandboxEnvironment, useSandboxState } from "../../state/sandboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
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
  type MobileSandboxBadgeTone,
} from "./cloudSandboxes.logic";

const BADGE_TONE_CLASS_NAMES: Readonly<Record<MobileSandboxBadgeTone, readonly [string, string]>> =
  {
    info: ["bg-primary/12", "text-primary-text"],
    success: ["bg-success/15", "text-success-foreground"],
    muted: ["bg-subtle", "text-foreground-muted"],
    warning: ["bg-warning/15", "text-warning-foreground"],
    danger: ["bg-danger/15", "text-danger-foreground"],
  };

function formatMobileCommandError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return errorDisplayMessage(error, resolveMessage) ?? (error.message.trim() || fallback);
  }
  return fallback;
}

function SandboxActionChip(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly tone?: "default" | "primary" | "danger";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const tone = props.tone ?? "default";
  const containerClassName =
    tone === "primary"
      ? "border-primary/40 bg-primary/12"
      : tone === "danger"
        ? "border-danger/30 bg-danger/10"
        : "border-border bg-surface";
  const textClassName =
    tone === "primary"
      ? "text-primary-text"
      : tone === "danger"
        ? "text-danger-foreground"
        : "text-foreground";
  const iconClassName =
    tone === "primary"
      ? "accent-primary-text"
      : tone === "danger"
        ? "accent-danger-foreground"
        : "accent-icon";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-1.5 rounded-full border px-3 py-1.5 active:opacity-70",
        containerClassName,
        props.disabled && "opacity-50",
      )}
    >
      <SymbolView
        name={props.icon}
        size={13}
        tintColorClassName={iconClassName}
        type="monochrome"
      />
      <Text className={cn("text-xs font-t3-medium", textClassName)}>{props.label}</Text>
    </Pressable>
  );
}

type RowAction = "wake" | "snapshot" | "sleep" | "destroy" | "connect";

export function CloudSandboxesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const gt = useGT();
  const config = useEnvironmentServerConfig(props.environmentId);
  const supported = config?.environment.capabilities.sandboxes === true;

  const { state, loaded, error } = useSandboxState(supported ? props.environmentId : null);
  const canSpawn = useAtomValue(sandboxEnvironment.spawn.permissionAtom(props.environmentId));
  const canResume = useAtomValue(sandboxEnvironment.resume.permissionAtom(props.environmentId));
  const canSnapshot = useAtomValue(sandboxEnvironment.snapshot.permissionAtom(props.environmentId));
  const canStop = useAtomValue(sandboxEnvironment.stop.permissionAtom(props.environmentId));
  const canDestroy = useAtomValue(sandboxEnvironment.destroy.permissionAtom(props.environmentId));

  const spawnSandbox = useAtomCommand(sandboxEnvironment.spawn, { reportFailure: false });
  const resumeSandbox = useAtomCommand(sandboxEnvironment.resume, { reportFailure: false });
  const snapshotSandbox = useAtomCommand(sandboxEnvironment.snapshot, { reportFailure: false });
  const stopSandbox = useAtomCommand(sandboxEnvironment.stop, { reportFailure: false });
  const destroySandbox = useAtomCommand(sandboxEnvironment.destroy, { reportFailure: false });
  const connectPairingUrl = useAtomCommand(connectPairingUrlAtom, { reportFailure: false });

  const [sheetOpen, setSheetOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    readonly tone: "error" | "success";
    readonly text: string;
  } | null>(null);
  const [busySandboxAction, setBusySandboxAction] = useState<
    Readonly<Record<string, "wake" | "snapshot" | "sleep" | "destroy" | "connect">>
  >({});
  const [pendingPairingUrls, setPendingPairingUrls] = useState<ReadonlyMap<SandboxId, string>>(
    () => new Map(),
  );
  const [nowMs, setNowMs] = useState(Date.now);

  const hasSandboxes = supported && state.sandboxes.length > 0;
  useFocusEffect(
    useCallback(() => {
      if (!hasSandboxes) return;
      const updateNow = () => setNowMs(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      const subscription = AppState.addEventListener("change", (nextState) => {
        if (nextState === "active") updateNow();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [hasSandboxes]),
  );

  if (!supported) return null;

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

  const reportFailure = (
    result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    setStatusMessage({
      tone: "error",
      text: formatMobileCommandError(squashAtomCommandFailure(result), fallback),
    });
  };

  const handleConnectPairingUrl = async (
    sandbox: Pick<CloudSandboxRecord, "id" | "name">,
    pairingUrl: string,
  ) => {
    setRowBusy(sandbox.id, "connect");
    setStatusMessage(null);
    const result = await connectPairingUrl({ pairingUrl });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Success") {
      forgetPairingUrl(sandbox.id);
      setStatusMessage({
        tone: "success",
        text: gt("{name} joined your KBCode environments.", { name: sandbox.name }),
      });
      return true;
    }

    if (!isAtomCommandInterrupted(result)) {
      rememberPairingUrl(sandbox.id, pairingUrl);
      setStatusMessage({
        tone: "error",
        text: formatMobileCommandError(
          squashAtomCommandFailure(result),
          gt("Could not connect to the cloud sandbox yet."),
        ),
      });
    }
    return false;
  };

  const handleWake = async (sandbox: CloudSandboxRecord) => {
    if (!canResume) return;
    setRowBusy(sandbox.id, "wake");
    setStatusMessage(null);
    const result = await resumeSandbox({
      environmentId: props.environmentId,
      input: { id: sandbox.id },
    });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Failure") {
      reportFailure(result, gt("Failed to wake cloud sandbox."));
      return;
    }

    const { sandbox: resumed, pairingUrl } = result.value;
    if (pairingUrl) {
      rememberPairingUrl(resumed.id, pairingUrl);
      const alreadyConnected =
        resumed.environmentId !== null && props.connectedEnvironmentIds.has(resumed.environmentId);
      if (!alreadyConnected) {
        await handleConnectPairingUrl(resumed, pairingUrl);
        return;
      }
    }

    setStatusMessage({
      tone: "success",
      text: gt("{name} is ready.", { name: resumed.name }),
    });
  };

  const handleSnapshot = async (sandbox: CloudSandboxRecord) => {
    if (!canSnapshot) return;
    setRowBusy(sandbox.id, "snapshot");
    setStatusMessage(null);
    const result = await snapshotSandbox({
      environmentId: props.environmentId,
      input: { id: sandbox.id },
    });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Failure") {
      reportFailure(result, gt("Failed to capture sandbox snapshot."));
      return;
    }

    setStatusMessage({
      tone: "success",
      text: gt("Saved snapshot {snapshotId}.", { snapshotId: result.value.snapshotId }),
    });
  };

  const handleSleep = async (sandbox: CloudSandboxRecord) => {
    if (!canStop) return;
    setRowBusy(sandbox.id, "sleep");
    setStatusMessage(null);
    const result = await stopSandbox({
      environmentId: props.environmentId,
      input: { id: sandbox.id },
    });
    setRowBusy(sandbox.id, null);

    if (result._tag === "Failure") {
      reportFailure(result, gt("Failed to put sandbox to sleep."));
      return;
    }

    setStatusMessage({
      tone: "success",
      text: gt("{name} has been paused to preserve free-tier credits.", { name: sandbox.name }),
    });
  };

  const handleDestroy = (sandbox: CloudSandboxRecord) => {
    if (!canDestroy) return;
    Dialog.confirm({
      title: gt("Destroy cloud sandbox?"),
      message: gt(
        "Destroy {name}? Unsaved files outside a saved snapshot will be permanently deleted.",
        { name: sandbox.name },
      ),
      confirmText: gt("Destroy"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setRowBusy(sandbox.id, "destroy");
          setStatusMessage(null);
          const result = await destroySandbox({
            environmentId: props.environmentId,
            input: { id: sandbox.id },
          });
          setRowBusy(sandbox.id, null);

          if (result._tag === "Failure") {
            reportFailure(result, gt("Failed to destroy cloud sandbox."));
            return;
          }

          forgetPairingUrl(sandbox.id);
          setStatusMessage({
            tone: "success",
            text: gt("{name} was permanently removed.", { name: sandbox.name }),
          });
        })();
      },
    });
  };

  const sortedSandboxes = sortCloudSandboxes(state.sandboxes);
  const sectionTitle =
    props.environmentLabel === null
      ? gt("Cloud Sandboxes")
      : gt("Cloud Sandboxes · {environment}", { environment: props.environmentLabel });

  return (
    <View className="mt-5 gap-3">
      <SettingsSection
        title={sectionTitle}
        titleIcon={
          <SymbolView
            name="cloud"
            size={15}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        }
        trailing={
          canSpawn ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("New Cloud Sandbox")}
              onPress={() => setSheetOpen(true)}
              className="flex-row items-center gap-1 rounded-full bg-primary/12 px-3 py-1 active:opacity-70"
            >
              <SymbolView
                name="plus"
                size={12}
                tintColorClassName="accent-primary-text"
                type="monochrome"
              />
              <Text className="text-xs font-t3-medium text-primary-text">
                <T>New Cloud Sandbox</T>
              </Text>
            </Pressable>
          ) : undefined
        }
      >
        {statusMessage ? (
          <View
            className={cn(
              "px-4 py-2.5",
              statusMessage.tone === "error" ? "bg-danger/10" : "bg-success/10",
            )}
          >
            <Text
              className={cn(
                "text-xs",
                statusMessage.tone === "error"
                  ? "text-danger-foreground"
                  : "text-success-foreground",
              )}
            >
              {statusMessage.text}
            </Text>
          </View>
        ) : null}

        {error ? (
          <View className="gap-1 p-4">
            <Text className="text-sm font-t3-medium text-foreground">
              <T>Could not load cloud sandboxes</T>
            </Text>
            <Text className="text-xs text-danger-foreground">{error}</Text>
          </View>
        ) : !loaded ? (
          <View className="p-4">
            <Text className="text-sm text-foreground-muted">
              <T>Loading cloud sandboxes…</T>
            </Text>
          </View>
        ) : sortedSandboxes.length === 0 ? (
          <View className="gap-3 p-4">
            <View className="gap-1">
              <Text className="text-sm font-t3-medium text-foreground">
                <T>No cloud sandboxes yet</T>
              </Text>
              <Text className="text-xs leading-relaxed text-foreground-muted">
                <T>
                  Launch an isolated cloud VM on CodeSandbox, Upstash Box, or Vercel Sandbox with
                  automatic idle hibernation.
                </T>
              </Text>
            </View>
            {canSpawn ? (
              <Button
                label={gt("New Cloud Sandbox")}
                icon="plus"
                tone="primary"
                size="compact"
                onPress={() => setSheetOpen(true)}
              />
            ) : null}
          </View>
        ) : (
          sortedSandboxes.map((sandbox) => (
            <SandboxRow
              key={sandbox.id}
              sandbox={sandbox}
              busyAction={busySandboxAction[sandbox.id] ?? null}
              nowMs={nowMs}
              pairingUrl={pendingPairingUrls.get(sandbox.id) ?? null}
              isConnected={
                sandbox.environmentId !== null &&
                props.connectedEnvironmentIds.has(sandbox.environmentId)
              }
              permissions={{ canResume, canSnapshot, canStop, canDestroy }}
              onConnect={handleConnectPairingUrl}
              onWake={handleWake}
              onSnapshot={handleSnapshot}
              onSleep={handleSleep}
              onDestroy={handleDestroy}
            />
          ))
        )}
      </SettingsSection>

      {canSpawn && sheetOpen ? (
        <NewCloudSandboxSheet
          providers={state.providers}
          defaultIdleTimeoutMinutes={state.defaultIdleTimeoutMinutes}
          onClose={() => setSheetOpen(false)}
          onSpawn={async (input) => {
            const result = await spawnSandbox({ environmentId: props.environmentId, input });
            if (result._tag === "Failure") {
              if (isAtomCommandInterrupted(result)) return { ok: false as const, error: null };
              return {
                ok: false as const,
                error: formatMobileCommandError(
                  squashAtomCommandFailure(result),
                  gt("Failed to launch cloud sandbox."),
                ),
              };
            }

            const { sandbox, pairingUrl } = result.value;
            setSheetOpen(false);
            if (pairingUrl) {
              rememberPairingUrl(sandbox.id, pairingUrl);
              void handleConnectPairingUrl(sandbox, pairingUrl);
            } else {
              setStatusMessage({
                tone: "success",
                text: gt("{name} is ready.", { name: sandbox.name }),
              });
            }
            return { ok: true as const };
          }}
        />
      ) : null}
    </View>
  );
}

type SandboxRowProps = {
  readonly sandbox: CloudSandboxRecord;
  readonly busyAction: RowAction | null;
  readonly nowMs: number;
  readonly pairingUrl: string | null;
  readonly isConnected: boolean;
  readonly permissions: {
    readonly canResume: boolean;
    readonly canSnapshot: boolean;
    readonly canStop: boolean;
    readonly canDestroy: boolean;
  };
  readonly onConnect: (sandbox: CloudSandboxRecord, pairingUrl: string) => Promise<boolean>;
  readonly onWake: (sandbox: CloudSandboxRecord) => Promise<void>;
  readonly onSnapshot: (sandbox: CloudSandboxRecord) => Promise<void>;
  readonly onSleep: (sandbox: CloudSandboxRecord) => Promise<void>;
  readonly onDestroy: (sandbox: CloudSandboxRecord) => void;
};

function SandboxDetails({
  sandbox,
  nowMs,
  isConnected,
}: Pick<SandboxRowProps, "sandbox" | "nowMs" | "isConnected">) {
  const gt = useGT();
  const messages = useMessages();
  const badge = resolveSandboxStatusBadge(sandbox.state, messages);
  const [badgeBg, badgeText] = BADGE_TONE_CLASS_NAMES[badge.tone];
  const runtime = formatSandboxRuntimeDuration(sandbox, nowMs);
  const vercelWarning = isVercelRuntimeWarningActive(sandbox, nowMs);
  const harnessLabel = formatSandboxAgentHarness(sandbox.agentHarness, messages);
  const providerLabel = messages(SANDBOX_PROVIDER_META[sandbox.provider].label);

  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-base font-t3-bold text-foreground">{sandbox.name}</Text>
        <View className={cn("rounded-full px-2 py-0.5", badgeBg)}>
          <Text className={cn("text-xs font-t3-medium", badgeText)}>{badge.label}</Text>
        </View>
        <View className="rounded-full border border-border px-2 py-0.5">
          <Text className="text-xs text-foreground-muted">{providerLabel}</Text>
        </View>
        {isConnected ? (
          <View className="rounded-full bg-subtle px-2 py-0.5">
            <Text className="text-xs text-foreground-muted">
              <T>Connected</T>
            </Text>
          </View>
        ) : null}
      </View>

      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
        {runtime ? (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name="clock"
              size={12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <Text className="text-xs text-foreground-muted">{runtime}</Text>
          </View>
        ) : null}
        <Text className="text-xs text-foreground-muted">
          {gt("{minutes}m idle timeout", { minutes: sandbox.idleTimeoutMinutes })}
        </Text>
        {harnessLabel ? (
          <Text className="text-xs text-foreground-muted">{harnessLabel}</Text>
        ) : null}
      </View>

      {sandbox.repoUrl ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {sandbox.repoUrl}
          {sandbox.branch ? ` (${sandbox.branch})` : ""}
        </Text>
      ) : null}

      {sandbox.snapshotId ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {gt("Snapshot: {id}", { id: sandbox.snapshotId })}
        </Text>
      ) : null}

      {vercelWarning ? (
        <View className="flex-row items-center gap-1.5 pt-0.5">
          <SymbolView
            name="exclamationmark.triangle"
            size={13}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
          <Text className="flex-1 text-xs text-warning-foreground">
            <T>Approaching Vercel 45m continuous limit. Auto-snapshot imminent.</T>
          </Text>
        </View>
      ) : null}

      {sandbox.lastError ? (
        <Text className="text-xs text-danger-foreground">{sandbox.lastError}</Text>
      ) : null}
    </View>
  );
}

function SandboxRowActions({
  sandbox,
  busyAction,
  pairingUrl,
  isConnected,
  permissions,
  onConnect,
  onWake,
  onSnapshot,
  onSleep,
  onDestroy,
}: Omit<SandboxRowProps, "nowMs">) {
  const gt = useGT();
  const actions = resolveSandboxRowActions(sandbox.state, busyAction !== null);

  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {pairingUrl && !isConnected ? (
        <SandboxActionChip
          label={busyAction === "connect" ? gt("Connecting…") : gt("Connect")}
          icon="link"
          tone="primary"
          disabled={busyAction !== null}
          onPress={() => void onConnect(sandbox, pairingUrl)}
        />
      ) : null}
      {permissions.canResume && actions.canWake ? (
        <SandboxActionChip
          label={busyAction === "wake" ? gt("Waking…") : gt("Wake")}
          icon="play"
          disabled={busyAction !== null}
          onPress={() => void onWake(sandbox)}
        />
      ) : null}
      {permissions.canSnapshot && actions.canSnapshot ? (
        <SandboxActionChip
          label={busyAction === "snapshot" ? gt("Snapshotting…") : gt("Snapshot")}
          icon="camera"
          disabled={busyAction !== null}
          onPress={() => void onSnapshot(sandbox)}
        />
      ) : null}
      {permissions.canStop && actions.canSleep ? (
        <SandboxActionChip
          label={busyAction === "sleep" ? gt("Sleeping…") : gt("Sleep")}
          icon="moon"
          disabled={busyAction !== null}
          onPress={() => void onSleep(sandbox)}
        />
      ) : null}
      {permissions.canDestroy && actions.canDestroy ? (
        <SandboxActionChip
          label={busyAction === "destroy" ? gt("Destroying…") : gt("Destroy")}
          icon="trash"
          tone="danger"
          disabled={busyAction !== null}
          onPress={() => onDestroy(sandbox)}
        />
      ) : null}
    </View>
  );
}

function SandboxRow(props: SandboxRowProps) {
  return (
    <View className="gap-2.5 p-4">
      <SandboxDetails sandbox={props.sandbox} nowMs={props.nowMs} isConnected={props.isConnected} />
      <SandboxRowActions {...props} />
    </View>
  );
}

function NewCloudSandboxSheet(props: {
  readonly providers: ReadonlyArray<SandboxProviderAvailability>;
  readonly defaultIdleTimeoutMinutes: number;
  readonly onClose: () => void;
  readonly onSpawn: (
    input: SandboxSpawnInput,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string | null }>;
}) {
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const [provider, setProvider] = useState<SandboxProviderKind>(() =>
    resolveDefaultSandboxProvider(props.providers),
  );
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [agentHarness, setAgentHarness] = useState("primeAgent");
  const [snapshotId, setSnapshotId] = useState("");
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(
    String(props.defaultIdleTimeoutMinutes),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSpawning, setIsSpawning] = useState(false);

  const selectedAvailability = getSandboxProviderAvailability(props.providers, provider);
  const anyConfigured =
    props.providers.length === 0 || props.providers.some((entry) => entry.configured);

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
      {
        providers: props.providers,
        defaultIdleTimeoutMinutes: props.defaultIdleTimeoutMinutes,
      },
      messages,
    );
    if (!built.ok) {
      setError(built.error);
      return;
    }

    setError(null);
    setIsSpawning(true);
    const outcome = await props.onSpawn(built.input);
    setIsSpawning(false);
    if (!outcome.ok && outcome.error) {
      setError(outcome.error);
    }
  };

  return (
    <Sheet title={gt("New Cloud Sandbox")} onClose={props.onClose} dismissDisabled={isSpawning}>
      <ScrollView
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <Text className="text-sm leading-5 text-foreground-muted">
          <T>
            Boot an isolated cloud VM running KBCode headless and connect it directly to your
            environment switcher.
          </T>
        </Text>

        {error ? (
          <View className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3">
            <Text className="text-xs text-danger-foreground">{error}</Text>
          </View>
        ) : null}

        <View className="gap-2">
          <Text className="text-sm font-t3-medium text-foreground">
            <T>Provider</T>
          </Text>
          {SANDBOX_PROVIDER_KINDS.map((kind) => {
            const meta = SANDBOX_PROVIDER_META[kind];
            const availability = getSandboxProviderAvailability(props.providers, kind);
            const isSelected = provider === kind;
            const isConfigured = props.providers.length === 0 || availability.configured;
            return (
              <Pressable
                key={kind}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected, disabled: isSpawning }}
                disabled={isSpawning}
                onPress={() => {
                  setProvider(kind);
                  setError(null);
                }}
                className={cn(
                  "gap-1 rounded-2xl border p-3.5",
                  isSelected ? "border-primary bg-primary/8" : "border-border bg-grouped-card",
                  !isConfigured && "opacity-70",
                )}
              >
                <View className="flex-row items-center justify-between gap-2">
                  <Text className="text-sm font-t3-bold text-foreground">
                    {messages(meta.label)}
                  </Text>
                  {!isConfigured ? (
                    <View className="rounded-full border border-border px-2 py-0.5">
                      <Text className="text-xs text-foreground-muted">
                        <T>Not configured</T>
                      </Text>
                    </View>
                  ) : availability.defaultSnapshotId ? (
                    <View className="rounded-full bg-subtle px-2 py-0.5">
                      <Text className="text-xs text-foreground-muted">
                        <T>Base snapshot</T>
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text className="text-xs text-foreground-muted">{messages(meta.freeTierHint)}</Text>
                {!isConfigured && availability.reason ? (
                  <Text className="text-xs text-danger-foreground">{availability.reason}</Text>
                ) : null}
              </Pressable>
            );
          })}
          {!anyConfigured ? (
            <Text className="text-xs text-foreground-muted">
              <T>
                Configure CODESANDBOX_API_KEY, UPSTASH_BOX_API_KEY, or VERCEL_TOKEN on your host
                server to enable launching sandboxes.
              </T>
            </Text>
          ) : null}
        </View>

        <View className="gap-3">
          <View className="gap-1.5">
            <Text className="text-sm font-t3-medium text-foreground">
              {gt("Repository URL (optional)")}
            </Text>
            <AppTextInput
              value={repoUrl}
              onChangeText={setRepoUrl}
              placeholder="https://github.com/org/repo.git"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSpawning}
              className="rounded-xl border border-border bg-grouped-card px-3.5 py-2.5 text-sm text-foreground"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-t3-medium text-foreground">
              {gt("Branch (optional)")}
            </Text>
            <AppTextInput
              value={branch}
              onChangeText={setBranch}
              placeholder="main"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSpawning}
              className="rounded-xl border border-border bg-grouped-card px-3.5 py-2.5 text-sm text-foreground"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-t3-medium text-foreground">
              {gt("Sandbox name (optional)")}
            </Text>
            <AppTextInput
              value={name}
              onChangeText={setName}
              placeholder="feature-box"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSpawning}
              className="rounded-xl border border-border bg-grouped-card px-3.5 py-2.5 text-sm text-foreground"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-t3-medium text-foreground">
              <T>Default agent harness</T>
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {SANDBOX_AGENT_HARNESS_OPTIONS.map((option) => {
                const selected = agentHarness === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled: isSpawning }}
                    disabled={isSpawning}
                    onPress={() => setAgentHarness(option.value)}
                    className={cn(
                      "rounded-full border px-3.5 py-1.5",
                      selected ? "border-primary bg-primary/12" : "border-border bg-grouped-card",
                    )}
                  >
                    <Text
                      className={cn(
                        "text-xs font-t3-medium",
                        selected ? "text-primary-text" : "text-foreground",
                      )}
                    >
                      {messages(option.label)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-t3-medium text-foreground">
              {gt("Snapshot / base image (optional)")}
            </Text>
            <AppTextInput
              value={snapshotId}
              onChangeText={setSnapshotId}
              placeholder={
                selectedAvailability.defaultSnapshotId ?? gt("Saved snapshot ID (optional)")
              }
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSpawning}
              className="rounded-xl border border-border bg-grouped-card px-3.5 py-2.5 text-sm text-foreground"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-t3-medium text-foreground">
              <T>Auto-hibernate (minutes)</T>
            </Text>
            <AppTextInput
              value={idleTimeoutMinutes}
              onChangeText={setIdleTimeoutMinutes}
              keyboardType="number-pad"
              placeholder={String(props.defaultIdleTimeoutMinutes)}
              editable={!isSpawning}
              className="rounded-xl border border-border bg-grouped-card px-3.5 py-2.5 text-sm text-foreground"
            />
          </View>
        </View>

        <Button
          label={isSpawning ? gt("Launching…") : gt("Launch Cloud Sandbox")}
          tone="primary"
          fullWidth
          loading={isSpawning}
          disabled={props.providers.length > 0 && !selectedAvailability.configured}
          onPress={() => void handleSubmit()}
        />
      </ScrollView>
    </Sheet>
  );
}
