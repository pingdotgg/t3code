/** Settings → Model Routing (fork feature f5). */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CLAUDE_CODEX_BRIDGE_VERSION,
  DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
  type ClaudeCodexClaudeSubagentModel,
  type ClaudeCodexModelPreferences,
  type ClaudeCodexRoutingPromptMode,
  type ClaudeCodexRoutingSettings,
  type ClaudeCodexSecondOpinionMode,
  type ClaudeCodexTaskRoute,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  DEFAULT_CLAUDE_CODEX_MODEL,
  effectiveClaudeCodexModel,
  resolveClaudeCodexRoutingPrompt,
} from "@t3tools/shared/claudeCodexRouting";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  RefreshCwIcon,
  RouteIcon,
  ShieldCheckIcon,
  UnplugIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironment } from "../../state/environments";
import { claudeCodexRoutingEnvironment } from "../../state/claudeCodexRouting";
import { useEnvironmentQuery } from "../../state/query";
import {
  primaryServerConfigAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildClaudeCodexRoutingPatch,
  claudeRoutingProviders,
  readClaudeCodexRouting,
} from "./ModelRoutingSettings.logic";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PROMPT_MODES: ReadonlyArray<{
  readonly value: ClaudeCodexRoutingPromptMode;
  readonly label: string;
}> = [
  { value: "managed", label: "T3 preferences" },
  { value: "custom", label: "Custom policy" },
  { value: "none", label: "Bridge facts only" },
];

const TASK_ROUTE_OPTIONS: ReadonlyArray<{
  readonly value: ClaudeCodexTaskRoute;
  readonly label: string;
}> = [
  { value: "claude", label: "Claude subagent" },
  { value: "codex", label: "Codex subagent" },
  { value: "adaptive", label: "Best fit" },
];

const CLAUDE_SUBAGENT_MODEL_FAMILIES: ReadonlyArray<{
  readonly value: ClaudeCodexClaudeSubagentModel;
  readonly slugPrefix: string;
  readonly fallbackLabel: string;
}> = [
  { value: "opus", slugPrefix: "claude-opus-", fallbackLabel: "Claude Opus" },
  { value: "fable", slugPrefix: "claude-fable-", fallbackLabel: "Claude Fable" },
  { value: "sonnet", slugPrefix: "claude-sonnet-", fallbackLabel: "Claude Sonnet" },
];

function claudeSubagentModelOptions(models: ReadonlyArray<ServerProviderModel>) {
  return CLAUDE_SUBAGENT_MODEL_FAMILIES.map((family) => {
    const model =
      models.find(
        (candidate) => candidate.slug.startsWith(family.slugPrefix) && candidate.isLegacy !== true,
      ) ?? models.find((candidate) => candidate.slug.startsWith(family.slugPrefix));
    return {
      value: family.value,
      label: model?.name ?? family.fallbackLabel,
      available: model !== undefined,
    };
  });
}

type TaskPreferenceKey = Exclude<
  keyof ClaudeCodexModelPreferences,
  "claudeSubagentModel" | "claudeSubagentModels" | "secondOpinion"
>;

const TASK_PREFERENCE_ROWS: ReadonlyArray<{
  readonly key: TaskPreferenceKey;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: "exploration",
    label: "Exploration & research",
    description: "Codebase mapping, evidence gathering, and independent investigation.",
  },
  {
    key: "implementation",
    label: "Implementation & refactors",
    description: "Clear-spec changes, migrations, refactors, and mechanical edits.",
  },
  {
    key: "verification",
    label: "Tests & verification",
    description: "Reproducing defects, running checks, and verifying concrete claims.",
  },
  {
    key: "planning",
    label: "Planning & architecture",
    description: "Plans, tradeoffs, system design, and ambiguous technical direction.",
  },
  {
    key: "design",
    label: "UI, UX & product design",
    description: "Interaction design, visual decisions, product judgment, and copy.",
  },
  {
    key: "review",
    label: "Review & final analysis",
    description: "Code review, risk assessment, synthesis, and final conclusions.",
  },
];

const SECOND_OPINION_OPTIONS: ReadonlyArray<{
  readonly value: ClaudeCodexSecondOpinionMode;
  readonly label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "plans", label: "Plans only" },
  { value: "reviews", label: "Reviews only" },
  { value: "plans-and-reviews", label: "Plans & reviews" },
];

function commandError(result: { readonly cause: unknown }, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  if (error instanceof Error && error.message.trim()) return error.message;
  return typeof error === "string" && error.trim() ? error : fallback;
}

function CopyAction({ value, label }: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      onClick={() => copyToClipboard(value)}
    >
      {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function CodexBridgeSignInDialog({
  open,
  initialAttempt,
  environmentId,
  onOpenChange,
  onCompleted,
}: {
  readonly open: boolean;
  readonly initialAttempt: number;
  readonly environmentId: EnvironmentId | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCompleted: () => void;
}) {
  const [attempt, setAttempt] = useState(initialAttempt);
  const eventAtom =
    open && environmentId
      ? claudeCodexRoutingEnvironment.signInEvents({
          environmentId,
          input: { attempt },
        })
      : null;
  const events = useEnvironmentQuery(eventAtom);
  const event = events.data ?? undefined;
  const openedUrlRef = useRef<string | null>(null);
  const completedRef = useRef(false);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    if (event?._tag !== "deviceCode" || openedUrlRef.current === event.verificationUrl) return;
    openedUrlRef.current = event.verificationUrl;
    void ensureLocalApi()
      .shell.openExternal(event.verificationUrl)
      .catch(() => undefined);
  }, [event]);

  useEffect(() => {
    if (event?._tag !== "completed" || completedRef.current) return;
    completedRef.current = true;
    onCompletedRef.current();
    const timer = setTimeout(() => onOpenChange(false), 1_200);
    return () => clearTimeout(timer);
  }, [event, onOpenChange]);

  const retry = () => {
    completedRef.current = false;
    openedUrlRef.current = null;
    setAttempt((value) => value + 1);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {event?._tag === "completed" ? "Codex connected" : "Connect Codex"}
            </DialogTitle>
            <DialogDescription>
              Authorize the isolated account used only by Claude Code model routing.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            {event === undefined || event._tag === "started" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                <span>Installing the verified bridge and requesting a device code…</span>
              </div>
            ) : null}
            {event?._tag === "deviceCode" ? (
              <div className="grid gap-3">
                <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/40 p-3">
                  <code className="font-mono text-2xl tracking-[0.18em]">{event.userCode}</code>
                  <CopyAction value={event.userCode} label="Copy device code" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Enter the code at{" "}
                  <a
                    className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                    href={event.verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenAI device login <ExternalLinkIcon className="size-3" />
                  </a>
                </p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-3.5" /> Waiting for confirmation…
                </div>
              </div>
            ) : null}
            {event?._tag === "completed" ? (
              <div className="flex items-center gap-2 text-sm">
                <CheckIcon className="size-4 text-success" /> Ready for Claude Code routing.
              </div>
            ) : null}
            {event?._tag === "failed" || events.error ? (
              <div className="grid gap-3">
                <p className="whitespace-pre-wrap text-sm text-destructive">
                  {events.error ?? (event?._tag === "failed" ? event.message : "Sign-in failed.")}
                </p>
                <Button className="w-fit" size="sm" onClick={retry}>
                  Try again
                </Button>
              </div>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

function PromptEditor({
  label,
  description,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;
  return (
    <SettingsRow title={label} description={description}>
      <div className="mt-3 max-w-3xl space-y-2 pb-3.5">
        <Textarea
          className="font-mono text-[13px]"
          rows={6}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">{draft.trim().length} characters</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(value)}>
              Discard
            </Button>
            <Button size="sm" variant="outline" disabled={!dirty} onClick={() => onSave(draft)}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

export function ModelRoutingSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primary = usePrimaryEnvironment();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const supported = serverConfig?.environment.capabilities.claudeCodexRouting === true;
  const claudeProviders = useMemo(() => claudeRoutingProviders(providers), [providers]);
  const [selectedId, setSelectedId] = useState<ProviderInstanceId | null>(null);
  const selected =
    claudeProviders.find((provider) => provider.instanceId === selectedId) ?? claudeProviders[0];
  const routing = selected
    ? readClaudeCodexRouting(settings, selected.instanceId)
    : DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS;
  const environmentId = primary?.environmentId ?? null;
  const target = environmentId && supported ? { environmentId, input: {} } : null;
  const [forceModelsRefresh, setForceModelsRefresh] = useState(false);
  const statusQuery = useEnvironmentQuery(
    target ? serverEnvironment.claudeCodexBridgeStatus(target) : null,
  );
  const modelsQuery = useEnvironmentQuery(
    environmentId && supported
      ? serverEnvironment.claudeCodexBridgeModels({
          environmentId,
          input: { refresh: forceModelsRefresh },
        })
      : null,
  );
  const install = useAtomCommand(serverEnvironment.installClaudeCodexBridge);
  const signOut = useAtomCommand(serverEnvironment.signOutClaudeCodexBridge);
  const [installing, setInstalling] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInAttempt, setSignInAttempt] = useState(0);
  const [signOutArmed, setSignOutArmed] = useState(false);

  const openSignIn = () => {
    setSignInAttempt((value) => value + 1);
    setSignInOpen(true);
  };

  useEffect(() => {
    if (!signOutArmed) return;
    const timer = setTimeout(() => setSignOutArmed(false), 5_000);
    return () => clearTimeout(timer);
  }, [signOutArmed]);

  const saveRouting = useCallback(
    (next: ClaudeCodexRoutingSettings) => {
      if (!selected) return;
      updateSettings(buildClaudeCodexRoutingPatch(settings, selected.instanceId, next));
    },
    [selected, settings, updateSettings],
  );

  const handleInstall = async () => {
    if (!environmentId || installing) return;
    setInstalling(true);
    const result = await install({ environmentId, input: {} });
    setInstalling(false);
    if (result._tag === "Success") {
      statusQuery.refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install the Codex bridge",
          description: commandError(result, "The bridge installation failed."),
        }),
      );
    }
  };

  const handleSignOut = async () => {
    if (!environmentId || signingOut) return;
    if (!signOutArmed) {
      setSignOutArmed(true);
      return;
    }
    setSignOutArmed(false);
    setSigningOut(true);
    const result = await signOut({ environmentId, input: {} });
    setSigningOut(false);
    if (result._tag === "Success") {
      statusQuery.refresh();
      modelsQuery.refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not disconnect Codex",
        description: commandError(result, "Sign-out failed."),
      });
    }
  };

  if (!supported) {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("model-routing")} title="Model routing">
          <SettingsRow
            title="Not available on this server"
            description="Update the environment to configure Claude Code → Codex routing."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const status = statusQuery.data;
  const effectiveModel = effectiveClaudeCodexModel(routing.model);
  const modelOptions = modelsQuery.data?.models ?? [{ id: DEFAULT_CLAUDE_CODEX_MODEL }];
  const exactPrompt = resolveClaudeCodexRoutingPrompt(routing, effectiveModel);
  const managedPreferencesActive = routing.promptMode === "managed";
  const claudeSubagentModels = selected ? claudeSubagentModelOptions(selected.models) : [];
  const modelPreferencesCustomized =
    routing.modelPreferences.claudeSubagentModel !==
      DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES.claudeSubagentModel ||
    TASK_PREFERENCE_ROWS.some(
      ({ key }) =>
        routing.modelPreferences.claudeSubagentModels[key] !==
        DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES.claudeSubagentModels[key],
    ) ||
    TASK_PREFERENCE_ROWS.some(
      ({ key }) => routing.modelPreferences[key] !== DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES[key],
    ) ||
    routing.modelPreferences.secondOpinion !== DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES.secondOpinion;

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("model-routing")}
        title="Claude Code → Codex"
        icon={<RouteIcon className="size-4 text-muted-foreground" />}
      >
        <SettingsRow
          {...searchableSetting("model-routing-account")}
          title="Codex bridge account"
          description="A separate, environment-local Codex login for the Claude Code Haiku slot. Credentials never pass through the T3 client."
          status={
            status?.supported === false ? (
              "This operating system or architecture is not supported."
            ) : status?.authenticated ? (
              status.account?.email ? (
                <RedactedSensitiveText
                  value={status.account.email}
                  ariaLabel="Reveal Codex bridge account email"
                  revealTooltip="Reveal account"
                  hideTooltip="Hide account"
                />
              ) : (
                (status.account?.plan ?? "Connected")
              )
            ) : statusQuery.isPending ? (
              "Checking connection…"
            ) : (
              "Not connected"
            )
          }
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={status?.authenticated ? "success" : "secondary"}>
                {status?.authenticated ? "Connected" : "Offline"}
              </Badge>
              {!status?.authenticated ? (
                <Button
                  size="sm"
                  onClick={openSignIn}
                  disabled={!environmentId || status?.supported === false}
                >
                  Connect Codex
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={status.supported === false}
                    onClick={openSignIn}
                  >
                    Switch account
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={signOutArmed ? "text-destructive" : "text-muted-foreground"}
                    disabled={signingOut}
                    onClick={() => void handleSignOut()}
                  >
                    {signingOut ? "Disconnecting…" : signOutArmed ? "Confirm" : "Disconnect"}
                  </Button>
                </>
              )}
            </div>
          }
        >
          <div className="mt-3 flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 pb-3 text-xs text-muted-foreground">
            <span>Runtime v{status?.version ?? CLAUDE_CODEX_BRIDGE_VERSION}</span>
            <span>
              {status?.installed ? "Verified runtime installed" : "Runtime not installed"}
            </span>
            {status?.running || modelsQuery.data?.source === "live" ? (
              <span>Bridge active</span>
            ) : (
              <span>Starts on demand</span>
            )}
            {!status?.installed ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                disabled={installing || status?.supported === false}
                onClick={() => void handleInstall()}
              >
                {installing ? <Spinner className="size-3" /> : null}
                {installing ? "Installing…" : "Install only"}
              </Button>
            ) : null}
          </div>
          {status?.supported === false || status?.error || statusQuery.error ? (
            <Alert variant="warning" className="mb-3 max-w-3xl">
              <InfoIcon />
              <AlertTitle>Bridge needs attention</AlertTitle>
              <AlertDescription>
                {statusQuery.error ??
                  status?.error ??
                  "No verified bridge runtime is available for this platform."}
              </AlertDescription>
            </Alert>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Haiku slot">
        {selected ? (
          <>
            <SettingsRow
              title="Claude Code instance"
              description="Routing is configured independently for each Claude Code account."
              control={
                <Select
                  value={selected.instanceId}
                  onValueChange={(value) => setSelectedId(String(value) as ProviderInstanceId)}
                >
                  <SelectTrigger className="w-full sm:w-56" aria-label="Claude Code instance">
                    <SelectValue>{selected.displayName ?? selected.instanceId}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {claudeProviders.map((provider) => (
                      <SelectItem key={provider.instanceId} value={provider.instanceId}>
                        {provider.displayName ?? provider.instanceId}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Route Haiku to Codex"
              description="Maps Claude Code's short haiku alias to the selected GPT/Codex model. Explicit Anthropic Haiku model IDs continue to use Anthropic."
              status="Takes effect when a new Claude Code session starts."
              control={
                <Switch
                  checked={routing.enabled}
                  disabled={!status?.authenticated}
                  aria-label="Route Haiku to Codex"
                  onCheckedChange={(checked) =>
                    saveRouting({ ...routing, enabled: Boolean(checked) })
                  }
                />
              }
            />
            <SettingsRow
              title="Codex model"
              description="The model Claude Code reaches whenever an agent or workflow uses model: haiku."
              status={
                modelsQuery.data?.error ?? `Catalog: ${modelsQuery.data?.source ?? "fallback"}`
              }
              control={
                <div className="flex items-center gap-2">
                  <Select
                    value={effectiveModel}
                    disabled={!status?.authenticated}
                    onValueChange={(value) => saveRouting({ ...routing, model: String(value) })}
                  >
                    <SelectTrigger className="w-full sm:w-56" aria-label="Codex routing model">
                      <SelectValue>{effectiveModel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {modelOptions.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.id}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh Codex models"
                    disabled={!status?.authenticated || modelsQuery.isPending}
                    onClick={() => {
                      if (forceModelsRefresh) modelsQuery.refresh();
                      else setForceModelsRefresh(true);
                    }}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                </div>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="No Claude Code instance"
            description="Enable Claude Code in Providers before configuring its Haiku slot."
          />
        )}
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("model-routing-preferences")}
        title="Model preferences"
      >
        {selected ? (
          <>
            <SettingsRow
              title="Subagent ownership"
              description="Choose the owner and, whenever Claude participates, its model for each category. Best fit uses Codex for mechanical work and the selected Claude model for judgment-heavy work."
              status={
                managedPreferencesActive
                  ? "The main session stays thin: it delegates, coordinates, and owns the final synthesis."
                  : "Inactive while a custom policy or bridge-facts-only mode is selected below."
              }
              resetAction={
                modelPreferencesCustomized ? (
                  <SettingResetButton
                    label="model preferences"
                    onClick={() =>
                      saveRouting({
                        ...routing,
                        modelPreferences: DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
                      })
                    }
                  />
                ) : undefined
              }
            >
              <div className="mt-3 max-w-3xl divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-muted/15">
                {TASK_PREFERENCE_ROWS.map((preference) => {
                  const route = routing.modelPreferences[preference.key];
                  const claudeModel =
                    routing.modelPreferences.claudeSubagentModels[preference.key] ??
                    routing.modelPreferences.claudeSubagentModel;
                  return (
                    <div
                      key={preference.key}
                      className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">
                          {preference.label}
                        </div>
                        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          {preference.description}
                        </div>
                      </div>
                      <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                        <Select
                          value={route}
                          disabled={!managedPreferencesActive}
                          onValueChange={(value) =>
                            saveRouting({
                              ...routing,
                              modelPreferences: {
                                ...routing.modelPreferences,
                                [preference.key]: String(value) as ClaudeCodexTaskRoute,
                              },
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-full shrink-0 sm:w-40"
                            aria-label={`${preference.label} owner`}
                          >
                            <SelectValue>
                              {TASK_ROUTE_OPTIONS.find((option) => option.value === route)?.label}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            {TASK_ROUTE_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        {route !== "codex" ? (
                          <Select
                            value={claudeModel}
                            disabled={!managedPreferencesActive}
                            onValueChange={(value) =>
                              saveRouting({
                                ...routing,
                                modelPreferences: {
                                  ...routing.modelPreferences,
                                  claudeSubagentModels: {
                                    ...routing.modelPreferences.claudeSubagentModels,
                                    [preference.key]: String(
                                      value,
                                    ) as ClaudeCodexClaudeSubagentModel,
                                  },
                                },
                              })
                            }
                          >
                            <SelectTrigger
                              size="sm"
                              className="w-full shrink-0 sm:w-36"
                              aria-label={`${preference.label} Claude model`}
                            >
                              <SelectValue>
                                {
                                  claudeSubagentModels.find((model) => model.value === claudeModel)
                                    ?.label
                                }
                              </SelectValue>
                            </SelectTrigger>
                            <SelectPopup align="end" alignItemWithTrigger={false}>
                              {claudeSubagentModels.map((model) => (
                                <SelectItem
                                  key={model.value}
                                  value={model.value}
                                  disabled={!model.available}
                                >
                                  {model.label}
                                  {!model.available ? " · unavailable" : ""}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SettingsRow>
            <SettingsRow
              title="Independent second opinion"
              description="For consequential work, a Claude and Codex subagent form blind independent views in parallel; the main session adjudicates disagreements. Routine tasks skip the extra pass."
              control={
                <Select
                  value={routing.modelPreferences.secondOpinion}
                  disabled={!managedPreferencesActive}
                  onValueChange={(value) =>
                    saveRouting({
                      ...routing,
                      modelPreferences: {
                        ...routing.modelPreferences,
                        secondOpinion: String(value) as ClaudeCodexSecondOpinionMode,
                      },
                    })
                  }
                >
                  <SelectTrigger className="w-full sm:w-48" aria-label="Independent second opinion">
                    <SelectValue>
                      {
                        SECOND_OPINION_OPTIONS.find(
                          (option) => option.value === routing.modelPreferences.secondOpinion,
                        )?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {SECOND_OPINION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="No Claude Code instance"
            description="Enable Claude Code in Providers before configuring model preferences."
          />
        )}
      </SettingsSection>

      <SettingsSection {...searchableSetting("model-routing-prompt")} title="Prompt instructions">
        <SettingsRow
          title="Preference instructions"
          description="Bridge mechanics are always injected. Use the structured T3 preferences above, replace only the preference policy, or inject the bridge facts alone."
          control={
            <Select
              value={routing.promptMode}
              disabled={!selected}
              onValueChange={(value) =>
                saveRouting({
                  ...routing,
                  promptMode: String(value) as ClaudeCodexRoutingPromptMode,
                })
              }
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Routing prompt mode">
                <SelectValue>
                  {PROMPT_MODES.find((mode) => mode.value === routing.promptMode)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {PROMPT_MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {routing.promptMode === "custom" ? (
          <PromptEditor
            label="Custom preference policy"
            description="Replaces the structured model preferences for this Claude instance. The fixed bridge mechanics remain intact."
            value={routing.customPrompt}
            placeholder="Explain how and when Claude should delegate work through the haiku slot…"
            onSave={(customPrompt) => saveRouting({ ...routing, customPrompt })}
          />
        ) : null}
        <PromptEditor
          label="Additional instructions"
          description="Appended after the bridge facts and managed or custom preference policy. Use this for project- or team-specific routing rules."
          value={routing.additionalInstructions}
          placeholder="Prefer Codex for independent implementation and review tasks…"
          disabled={!selected}
          onSave={(additionalInstructions) => saveRouting({ ...routing, additionalInstructions })}
        />
        <SettingsRow
          title="Exact prompt preview"
          description="The exact bridge facts, preference policy, and additions prepended to the normal T3 system-prompt rules for a new session."
          control={
            exactPrompt ? <CopyAction value={exactPrompt} label="Copy routing prompt" /> : undefined
          }
        >
          <div className="mt-3 max-w-3xl pb-3.5">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 px-3 py-3 font-mono text-[12px] leading-[1.55] text-foreground/90">
              {exactPrompt ?? "No routing prompt is injected."}
            </pre>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
              Claude&apos;s built-in system prompt remains intact. T3 appends this text through the
              official Claude Code preset API.
            </p>
          </div>
        </SettingsRow>
      </SettingsSection>

      <Alert variant="info">
        <UnplugIcon />
        <AlertTitle>Session-safe by design</AlertTitle>
        <AlertDescription>
          The bridge binds to loopback, uses a random local key, verifies its pinned download, and
          routes only recognized Codex model IDs away from Anthropic.
        </AlertDescription>
      </Alert>

      <CodexBridgeSignInDialog
        key={signInAttempt}
        open={signInOpen}
        initialAttempt={signInAttempt}
        environmentId={environmentId}
        onOpenChange={setSignInOpen}
        onCompleted={() => {
          statusQuery.refresh();
          modelsQuery.refresh();
        }}
      />
    </SettingsPageContainer>
  );
}
