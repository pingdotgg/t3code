import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionProjectCandidate,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  CopyIcon,
  LinkIcon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  groupOnboardingProjects,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
  type OnboardingProjectGroup,
} from "../../onboarding/projectImport.logic";
import {
  getOnboardingProviderState,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { newProjectId, randomUUID } from "../../lib/utils";
import { agentSessionImport } from "../../state/agentSessions";
import { readProjects, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { isOnboardingRelayEnvironment } from "../../onboarding/targetEnvironment.logic";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { ClaudeAI, OpenAI } from "../Icons";
import { T3Wordmark } from "../T3Wordmark";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { WizardPanel, WizardSteps } from "../ui/wizard";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";

/**
 * First-run welcome wizard. Rendered over the workspace at `/welcome` on a
 * fresh install (no completed-onboarding flag, empty workspace). Flow per the
 * onboarding overhaul spec: connection choice → sign-in/pair (remote paths) →
 * agent setup with inline install terminal → project import → main screen.
 * Every step past the connection gate is skippable; the whole wizard is
 * re-runnable by clearing the flag.
 */

type WizardStep = "connection" | "agents" | "import";
const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const ONBOARDING_STAGES = ["Connect", "Agents", "Projects"] as const;
const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";

export function WelcomeWizard({
  localAvailable,
  onDone,
}: {
  /** Whether this client is authenticated to the server serving the app. */
  readonly localAvailable: boolean;
  readonly onDone: (projectRef?: ScopedProjectRef) => void;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const [step, setStep] = useState<WizardStep>("connection");
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const autoSelectedComputers = useRef(new Set<EnvironmentId>());
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.current.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.current.add(environment.environmentId);
    }
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...newComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const scans = useProjectScans(step === "import" ? setupIds : NO_ENVIRONMENTS);
  const isLoadingProjects =
    step === "import" &&
    scans.every((scan) => scan.data === null) &&
    scans.some((scan) => scan.isPending);
  const startSetup = (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setStep("agents");
  };
  const stageIndex = step === "agents" ? 1 : step === "import" ? 2 : 0;
  const finish = useCallback(
    (projectRef?: ScopedProjectRef) => {
      if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
      if (completionErrorToastIdRef.current !== null) {
        toastManager.close(completionErrorToastIdRef.current);
        completionErrorToastIdRef.current = null;
      }

      const completion = completeOnboarding()
        .then(() => {
          if (completionErrorToastIdRef.current !== null) {
            toastManager.close(completionErrorToastIdRef.current);
            completionErrorToastIdRef.current = null;
          }
          onDone(projectRef);
          return true;
        })
        .catch(() => {
          const errorToast = {
            type: "error",
            title: "Could not finish setup",
            description: "Your settings could not be saved. Try again.",
          } as const;
          if (completionErrorToastIdRef.current === null) {
            completionErrorToastIdRef.current = toastManager.add(errorToast);
          } else {
            toastManager.update(completionErrorToastIdRef.current, errorToast);
          }
          return false;
        })
        .finally(() => {
          if (finishingPromiseRef.current === completion) {
            finishingPromiseRef.current = null;
          }
        });
      finishingPromiseRef.current = completion;
      return completion;
    },
    [completeOnboarding, onDone],
  );

  return (
    <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
      <DialogPopup
        className="max-w-xl overflow-x-hidden overflow-y-auto"
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <DialogTitle className="sr-only">Set up T3 Code</DialogTitle>
        <div className="flex min-h-0 flex-col">
          <DialogHeader className="gap-4">
            <div className="flex items-baseline gap-1.5" role="img" aria-label="T3 Code">
              <T3Wordmark className="h-4 w-auto shrink-0" aria-hidden />
              <span className="text-[1.4rem] font-medium tracking-tight text-muted-foreground">
                Code
              </span>
            </div>
            <WizardSteps
              steps={ONBOARDING_STAGES}
              currentStep={stageIndex}
              isStepDisabled={(index) => isImporting || index >= stageIndex}
              onStepChange={(index) => {
                if (isImporting || index > stageIndex) return;
                setStep(index === 0 ? "connection" : "agents");
              }}
            />
          </DialogHeader>

          <WizardPanel className="min-w-0" holdHeight={isLoadingProjects}>
            {step === "connection" ? (
              <ConnectionStep
                expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
                selectedIds={selectedIds}
                autoSelectedComputers={autoSelectedComputers.current}
                onSelectionChange={setSelection}
                onToggleEnvironment={(environmentId, checked) =>
                  setSelection((current) => {
                    const next = new Set(current ?? selectedIds);
                    if (checked) next.add(environmentId);
                    else next.delete(environmentId);
                    return next;
                  })
                }
                onContinue={() =>
                  startSetup(
                    environments
                      .filter((environment) => selectedIds.has(environment.environmentId))
                      .map((environment) => environment.environmentId),
                  )
                }
                onPaired={(environmentId) => {
                  setSelection(new Set([...selectedIds, environmentId]));
                }}
              />
            ) : step === "agents" ? (
              <AgentsStep environmentIds={setupIds} onContinue={() => setStep("import")} />
            ) : (
              <ImportStep
                scans={scans}
                isImporting={isImporting}
                setIsImporting={setIsImporting}
                onDone={finish}
              />
            )}
          </WizardPanel>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

// ── Step 1: connection choice ────────────────────────────────

function ConnectionStep({
  autoSelectedComputers,
  expandPairingInitially,
  selectedIds,
  onSelectionChange,
  onToggleEnvironment,
  onContinue,
  onPaired,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly expandPairingInitially: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onContinue: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const ready =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) =>
      environments.some(
        (environment) =>
          environment.environmentId === id && environment.connection.phase === "connected",
      ),
    );
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Connect your computers
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Choose one or more computers. We’ll set up agents and projects on each.
      </p>
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Computers to set up</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {environment.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {environment.connection.phase === "connected" ? "Connected" : "Connecting…"}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 space-y-2">
        {cloudEnabled ? (
          <ConnectAccountOption
            autoSelectedComputers={autoSelectedComputers}
            disabled={isPairing}
            selectedIds={selectedIds}
            onToggleEnvironment={onToggleEnvironment}
          />
        ) : null}
        <Collapsible
          open={pairingOpen}
          onOpenChange={setPairingOpen}
          className="rounded-lg border border-border bg-background"
        >
          <CollapsibleTrigger
            disabled={isPairing}
            render={
              <Button
                variant="ghost"
                className="h-auto min-h-14 w-full justify-start gap-3 px-3 py-3 text-left whitespace-normal sm:h-auto"
              />
            }
          >
            <LinkIcon className="size-4 text-muted-foreground" />
            <span className="flex-1">Add a computer</span>
            <ChevronRightIcon
              className={cn("size-4 text-muted-foreground", pairingOpen && "rotate-90")}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="px-3 pb-3">
              <PairingForm
                isPairing={isPairing}
                setIsPairing={setIsPairing}
                onPaired={(environmentId) => {
                  setPairingOpen(false);
                  onPaired(environmentId);
                  requestAnimationFrame(() => continueRef.current?.focus());
                }}
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
      <div className="mt-6 flex items-center justify-end gap-3">
        <Button
          ref={continueRef}
          autoFocus={!expandPairingInitially}
          disabled={!ready || isPairing}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function ConnectAccountOption({
  autoSelectedComputers,
  disabled,
  selectedIds,
  onToggleEnvironment,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [expanded, setExpanded] = useState(true);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = useCallback(() => setDiscoveryReady(true), []);

  return (
    <Collapsible
      open={expanded && !!isSignedIn && discoveryReady}
      onOpenChange={setExpanded}
      className="rounded-lg border border-border bg-background"
    >
      <CollapsibleTrigger
        disabled={disabled || !isLoaded}
        onClick={(event) => {
          if (!isSignedIn) {
            event.preventDefault();
            setExpanded(true);
            openAuthPrompt();
          }
        }}
        render={
          <Button
            variant="ghost"
            className="h-auto min-h-14 w-full justify-start gap-3 px-3 py-3 text-left whitespace-normal sm:h-auto"
          />
        }
      >
        <CloudIcon className="size-4 text-muted-foreground" />
        <span className="flex-1">T3 Connect</span>
        <span className="text-xs text-muted-foreground">
          {!isLoaded
            ? "Loading sign-in…"
            : !isSignedIn
              ? "Sign in"
              : !discoveryReady
                ? "Loading computers…"
                : null}
        </span>
        <ChevronRightIcon
          className={cn("size-4 text-muted-foreground", expanded && isSignedIn && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted>
        <div className="px-3 pb-3">
          <div className="mb-3 space-y-1.5">
            {isSignedIn ? (
              <CloudEnvironmentConnectRows
                primaryEnvironmentId={null}
                savedEnvironments={environments}
                showSavedEnvironments
                onDiscoveryReady={onDiscoveryReady}
                selection={{ selectedIds, onChange: onToggleEnvironment, autoSelectedComputers }}
                refreshWhileEmpty
                empty={
                  <p className="py-3 text-sm text-muted-foreground">No computers linked yet.</p>
                }
              />
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Run this on each computer you want to connect.
          </p>
          <CommandBlock command="npx t3 connect" className="mt-3" />
          <p className="mt-3 text-xs text-muted-foreground">
            Keep T3 Code running. Select the computers you want to set up above.
          </p>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// ── Step 2′: Direct pairing ──────────────────────────────────

/**
 * Register a computer in this browser using a server-minted pairing link.
 */
function PairingForm({
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (isPairing || pairingUrl.trim().length === 0) return;
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl: pairingUrl.trim() });
    if (!mountedRef.current) return;
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : "Pairing failed.");
  };

  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            Pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            autoFocus
            aria-invalid={errorMessage.length > 0}
            aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
            className="mt-2"
            size="lg"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            nativeInput
            readOnly={isPairing}
            placeholder="https://your-server:5230/pair#token=…"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {errorMessage ? (
          <div
            id="onboarding-pairing-error"
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </div>
        ) : null}
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger
              type="button"
              className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
              Need a pairing link?
            </CollapsibleTrigger>
            <Button type="submit" disabled={isPairing || pairingUrl.trim().length === 0}>
              {isPairing ? "Pairing..." : "Pair"}
            </Button>
          </div>
          <CollapsiblePanel className="pt-3">
            <p className="text-sm text-muted-foreground">
              Run this on the computer with your code.
            </p>
            <CommandBlock command="npx t3 pair" className="mt-2" />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Start T3 Code first, or run <code className="font-mono">npx t3 serve</code>. Add{" "}
              <code className="font-mono">--tailscale</code> to use your tailnet.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      </form>
    </>
  );
}

// ── Step 3: agents ───────────────────────────────────────────

const PRIMARY_AGENT_DRIVERS = ["claudeAgent", "codex"] as const;
type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

/** Setup values stay fixed while provider probes refresh the surrounding cards. */
interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

/**
 * Claude Code and Codex use live probe status. Install opens the built-in
 * terminal inline with the vendor's standalone installer pre-typed. The update
 * RPC can't install a binary that isn't there yet (it infers the installer from
 * the installed binary's path), and the terminal also handles the interactive
 * login that follows.
 */
function AgentsStep({
  environmentIds,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onContinue: () => void;
}) {
  const { environments } = useEnvironments();
  return (
    <StepShell title="Your agents" description="Agents available on your selected computers.">
      <ScrollArea
        scrollFade
        className="mt-5 h-auto max-h-96 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="space-y-5 pr-3">
          {environmentIds.map((environmentId) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              machineLabel={
                environments.find((environment) => environment.environmentId === environmentId)
                  ?.label ?? "Computer"
              }
            />
          ))}
        </div>
      </ScrollArea>
      <div className="mt-6 flex justify-end">
        <Button autoFocus onClick={onContinue}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);

  // Re-probe on entry so freshly installed CLIs show up without a manual
  // refresh; harmless when nothing changed (single-flighted per environment).
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  const byDriver = useMemo(() => selectOnboardingProvidersByDriver(providers), [providers]);

  const primaryAgents = PRIMARY_AGENT_DRIVERS.map((driver) => ({
    driver,
    provider: byDriver.get(driver),
  }));
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>
      <div className="space-y-1.5">
        {primaryAgents.map(({ driver, provider }) => (
          <AgentCard
            key={driver}
            driver={driver}
            provider={provider}
            terminalOpen={terminalSession?.driver === driver}
            terminalAvailable={serverConfig !== null}
            onOpenTerminal={() => {
              if (provider === undefined || serverConfig === null) return;
              setTerminalSession({
                environmentId,
                driver,
                providerInstanceId: provider.instanceId,
                cwd: serverConfig.cwd,
                command: provider.installed
                  ? resolveOnboardingProviderLoginCommand(
                      provider,
                      serverConfig.settings,
                      serverConfig.environment.platform.os,
                    )
                  : resolveOnboardingProviderInstallCommand(
                      driver,
                      serverConfig.environment.platform.os,
                    ),
                keybindings: serverConfig.keybindings,
              });
            }}
          />
        ))}
      </div>
      {terminalSession !== null ? (
        <AgentInstallTerminal
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.driver}`}
          session={terminalSession}
          onClose={() => {
            setTerminalSession(null);
            void refreshProviders({ environmentId, input: {} });
          }}
        />
      ) : null}
    </section>
  );
}

function AgentCard({
  driver,
  provider,
  terminalOpen,
  terminalAvailable,
  onOpenTerminal,
}: {
  readonly driver: OnboardingAgentDriver;
  readonly provider: ServerProvider | undefined;
  readonly terminalOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const meta = getDriverOption(ProviderDriverKind.make(driver));
  const Icon = meta?.icon;
  const displayName = driver === "claudeAgent" ? "Claude Code" : (meta?.label ?? driver);
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", driver !== "claudeAgent" && "fill-foreground")} />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {summary.headline}
          {summary.detail ? ` · ${summary.detail}` : ""}
        </p>
      </div>
      <div className="shrink-0">
        {providerState === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : providerState === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : providerState === "disabled" ? (
          <span className="text-xs text-muted-foreground">Disabled</span>
        ) : providerState === "attention" ? (
          <span className="text-xs text-muted-foreground">{summary.headline}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={onOpenTerminal}
            disabled={terminalOpen || !terminalAvailable}
          >
            <TerminalIcon className="size-3.5" />
            {providerState === "signIn" ? "Sign in" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline install terminal. Opens a PTY on the connected environment under a
 * synthetic onboarding thread id (terminals are keyed by free-form thread id;
 * the server validates only the cwd) and pre-types the install or login
 * command without submitting, so the user reviews and presses Enter.
 */
function AgentInstallTerminal({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close or pre-type
  // into the replacement session that shares this terminal id.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Every exit path unmounts the drawer (Done, Continue/Skip, card switch,
    // session exit), so this cleanup is the single place the PTY dies —
    // nothing is left running behind the wizard. An interrupted install is
    // re-runnable from the card.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div className="thread-terminal-drawer mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            "Review the command, then press Enter to run it."
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button size="xs" variant="ghost" onClick={() => setSetupAttempt((value) => value + 1)}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Install ${driver}`}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Step 4: import ───────────────────────────────────────────

function ImportStep({
  scans,
  isImporting,
  setIsImporting,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
}) {
  const { environments } = useEnvironments();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const projects = useProjects();
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string> | null>(null);
  const [importError, setImportError] = useState("");
  const [landingProject, setLandingProject] = useState<ScopedProjectRef | null>(null);
  // Keep project creation attempts separate from completed history imports so both can retry.
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // Ignore command completions after leaving the import step.
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (
      landingProject !== null &&
      projects.some(
        (project) =>
          project.id === landingProject.projectId &&
          project.environmentId === landingProject.environmentId,
      )
    ) {
      setLandingProject(null);
      void onDone(landingProject).then((completed) => {
        if (!completed) setIsImporting(false);
      });
    }
  }, [landingProject, onDone, projects, setIsImporting]);

  const { available: candidates, recent } = useMemo(
    () =>
      partitionOnboardingProjects(
        scans.flatMap((scan) =>
          (scan.data?.candidates ?? []).map((candidate) => ({
            ...candidate,
            environmentId: scan.environmentId,
            key: onboardingProjectKey(scan.environmentId, candidate.path),
          })),
        ),
      ),
    [scans],
  );
  const selectedKeys = useMemo(
    () => selectedPaths ?? new Set(recent.map((candidate) => candidate.key)),
    [selectedPaths, recent],
  );
  const selected = candidates.filter((candidate) => selectedKeys.has(candidate.key));

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    if (projectRef === undefined) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setLandingProject(projectRef);
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    if (selection.length === 0) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setImportError("");
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    // Interrupted imports are neither failures nor successes — the command was
    // superseded or the environment dropped — but they still didn't land, so
    // they must not read as "imported everything". Retries skip paths that
    // already landed this session (re-creating them would only trip the
    // duplicate-root invariant and read as a failure).
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.key)).length
        : 0;
    let importedThreadCount = 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    for (const candidate of selection) {
      const { environmentId } = candidate;
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (importedProjects.has(candidate.key)) continue;
      let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
      if (projectId === null) {
        let attempt = projectAttempts.get(candidate.key);
        if (attempt === undefined) {
          const nextProjectId = newProjectId();
          attempt = {
            projectId: nextProjectId,
            commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
          };
          projectAttempts.set(candidate.key, attempt);
        }
        projectId = attempt.projectId;
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            commandId: attempt.commandId,
            title: candidate.title,
            workspaceRoot: candidate.path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (
          importGeneration !== importGenerationRef.current ||
          importedProjects !== importedProjectsRef.current
        ) {
          return;
        }
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result)) {
            projectAttempts.delete(candidate.key);
            refreshEnvironments.add(environmentId);
          }
          continue;
        }
      }

      const threadImportResult = await importThreads({
        environmentId,
        input: { projectId, expectedWorkspaceRoot: candidate.path },
      });
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (threadImportResult._tag === "Success") {
        importedThreadCount += threadImportResult.value.importedCount;
        skippedThreadCount += threadImportResult.value.skippedCount;
        if (threadImportResult.value.importedCount > 0) {
          projectsWithImportedHistoryRef.current.set(
            candidate.key,
            scopeProjectRef(environmentId, projectId),
          );
        }
        if (threadImportResult.value.skippedCount === 0) {
          importedProjectsCount += 1;
          importedProjects.set(candidate.key, scopeProjectRef(environmentId, projectId));
        }
      } else if (!isAtomCommandInterrupted(threadImportResult)) {
        projectAttempts.delete(candidate.key);
        refreshEnvironments.add(environmentId);
      }
    }
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setIsImporting(false);
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. ${skippedThreadCount} ${skippedThreadCount === 1 ? "thread" : "threads"} could not be imported.`,
        );
      } else if (skippedThreadCount > 0) {
        setImportError(
          `${skippedThreadCount} ${skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`,
        );
      } else if (importedThreadCount > 0) {
        setImportError(
          `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. Some thread history could not be imported.`,
        );
      } else {
        setImportError("Could not import thread history.");
      }
      return;
    }
    finishAfterImport();
  };

  if (scans.every((scan) => scan.data === null) && scans.some((scan) => scan.isPending)) {
    return (
      <div className="flex h-full min-h-40 flex-col">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Your projects</h1>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6">
          <Spinner className="size-5 text-muted-foreground" />
          <p className="text-center text-sm text-muted-foreground">
            Looking for projects from Claude Code and Codex…
          </p>
        </div>
        <div className="flex justify-end">
          <Button variant="ghost-muted" onClick={() => void onDone()}>
            Do not import projects
          </Button>
        </div>
      </div>
    );
  }

  return (
    <StepShell
      title="Choose your projects"
      description="Import projects and conversations from your selected computers."
    >
      {candidates.length > 0 ? (
        <div className="mt-5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span role="status">
            {selected.length} of {candidates.length} selected
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={isImporting || selected.length === candidates.length}
              onClick={() => setSelectedPaths(new Set(candidates.map((item) => item.key)))}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={isImporting || selected.length === 0}
              onClick={() => setSelectedPaths(new Set())}
            >
              Select none
            </Button>
          </div>
        </div>
      ) : null}
      <ScrollArea
        scrollFade
        className="mt-2 h-auto max-h-80 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="space-y-5 pr-3">
          {scans.map((scan) => {
            const scanCandidates = candidates.filter(
              (candidate) => candidate.environmentId === scan.environmentId,
            );
            const label =
              environments.find((environment) => environment.environmentId === scan.environmentId)
                ?.label ?? "Computer";
            return (
              <fieldset
                key={scan.environmentId}
                className="min-w-0 space-y-0.5"
                disabled={isImporting}
              >
                {scans.length > 1 ? (
                  <legend className="mb-2 text-sm font-medium">{label}</legend>
                ) : null}
                {scan.isPending && scan.data === null ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Looking for projects…
                  </div>
                ) : scan.error !== null ? (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
                  >
                    <span>Could not check projects. {scan.error}</span>
                    <Button variant="ghost" size="sm" onClick={scan.refresh}>
                      Retry
                    </Button>
                  </div>
                ) : scanCandidates.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    No existing Claude Code or Codex projects found.
                  </p>
                ) : null}
                {scan.data?.truncated ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {SCAN_LIMIT_MESSAGE}
                  </p>
                ) : null}
                <ImportCandidateList
                  candidates={scanCandidates}
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedPaths}
                />
              </fieldset>
            );
          })}
        </div>
      </ScrollArea>
      {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <Button
          variant="ghost-muted"
          disabled={isImporting}
          onClick={importError ? finishAfterImport : () => void onDone()}
        >
          {importError ? "Continue without the rest" : "Do not import projects"}
        </Button>
        <Button
          autoFocus
          disabled={isImporting || selected.length === 0}
          onClick={() => void runImport(selected)}
        >
          {isImporting
            ? "Importing…"
            : `Import ${selected.length} ${selected.length === 1 ? "project" : "projects"}`}
        </Button>
      </div>
    </StepShell>
  );
}

type ImportCandidate = AgentSessionProjectCandidate & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
};

/**
 * Repositories first, newest activity on top. Clones of one repository share
 * a group with a tri-state checkbox. Folders that are not git repositories
 * sit collapsed at the bottom so they stay reachable without adding noise.
 * Source icons appear only on repository rows so the columns stay still.
 */
function ImportCandidateList({
  candidates,
  selectedKeys,
  onSelectionChange,
}: {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectionChange: (next: ReadonlySet<string>) => void;
}) {
  const { repositories, other } = useMemo(() => groupOnboardingProjects(candidates), [candidates]);
  const setKeys = (keys: ReadonlyArray<string>, checked: boolean) => {
    const next = new Set(selectedKeys);
    for (const key of keys) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onSelectionChange(next);
  };
  const otherSelected = other.filter((candidate) => selectedKeys.has(candidate.key)).length;

  return (
    <>
      {repositories.map((group) => (
        <ImportRepositoryGroup
          key={group.key}
          group={group}
          selectedKeys={selectedKeys}
          onToggle={setKeys}
        />
      ))}
      {other.length > 0 ? (
        <Collapsible>
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
            <Checkbox
              checked={otherSelected === other.length}
              indeterminate={otherSelected > 0 && otherSelected < other.length}
              onCheckedChange={(checked) =>
                setKeys(
                  other.map((candidate) => candidate.key),
                  checked === true,
                )
              }
            />
            <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
              <span className="truncate text-sm text-muted-foreground">Other folders</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {other.length} {other.length === 1 ? "folder" : "folders"}
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsiblePanel>
            {other.map((candidate) => (
              <ImportCandidateRow
                key={candidate.key}
                candidate={candidate}
                label={candidate.path}
                nested
                checked={selectedKeys.has(candidate.key)}
                onCheckedChange={(checked) => setKeys([candidate.key], checked)}
              />
            ))}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </>
  );
}

function ImportRepositoryGroup({
  group,
  selectedKeys,
  onToggle,
}: {
  readonly group: OnboardingProjectGroup<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onToggle: (keys: ReadonlyArray<string>, checked: boolean) => void;
}) {
  const keys = group.candidates.map((candidate) => candidate.key);
  const selectedCount = keys.filter((key) => selectedKeys.has(key)).length;
  const single = group.candidates.length === 1;
  const only = group.candidates[0];
  if (single && only !== undefined) {
    return (
      <ImportCandidateRow
        candidate={only}
        label={group.label}
        {...(group.repository === null ? {} : { secondary: only.path })}
        checked={selectedKeys.has(only.key)}
        onCheckedChange={(checked) => onToggle([only.key], checked)}
      />
    );
  }
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
        <Checkbox
          checked={selectedCount === keys.length}
          indeterminate={selectedCount > 0 && selectedCount < keys.length}
          onCheckedChange={(checked) => onToggle(keys, checked === true)}
        />
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          <span className="truncate text-sm font-medium">{group.label}</span>
          <ImportRowMeta
            sources={[...new Set(group.candidates.flatMap((c) => c.sources))]}
            threadCount={group.threadCount}
            lastActiveAt={group.lastActiveAt}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel>
        {group.candidates.map((candidate) => (
          <ImportCandidateRow
            key={candidate.key}
            candidate={candidate}
            label={candidate.path}
            nested
            checked={selectedKeys.has(candidate.key)}
            onCheckedChange={(checked) => onToggle([candidate.key], checked)}
          />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ImportCandidateRow({
  candidate,
  label,
  secondary,
  nested = false,
  checked,
  onCheckedChange,
}: {
  readonly candidate: ImportCandidate;
  readonly label: string;
  readonly secondary?: string;
  readonly nested?: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default",
        nested && "pl-8",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="flex min-w-0 flex-1 items-baseline gap-2 truncate" />}
        >
          <span className={cn("truncate", nested ? "font-mono text-xs" : "text-sm font-medium")}>
            {label}
          </span>
          {secondary !== undefined ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {secondary}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup className="max-w-96 break-all font-mono">{candidate.path}</TooltipPopup>
      </Tooltip>
      <ImportRowMeta
        sources={nested ? null : candidate.sources}
        threadCount={candidate.threadCount}
        lastActiveAt={candidate.lastActiveAt}
      />
    </label>
  );
}

/**
 * Trailing columns shared by every import row: source icons, thread count,
 * last activity. Each column has a fixed width and each icon has its own slot
 * so nothing shifts between rows that differ in sources or digit count.
 */
function ImportRowMeta({
  sources,
  threadCount,
  lastActiveAt,
}: {
  readonly sources: ReadonlyArray<"claudeAgent" | "codex"> | null;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}) {
  const relative = lastActiveAt === null ? null : formatRelativeTime(lastActiveAt);
  // "just now" does not fit the fixed column, so collapse it.
  const age = relative === null ? "" : relative.suffix === null ? "now" : relative.value;
  return (
    <span className="ml-auto grid shrink-0 grid-cols-[1rem_1rem_2.5rem_2.25rem] items-center gap-x-1 text-xs text-muted-foreground tabular-nums">
      <span className="flex size-4 items-center justify-center">
        {sources?.includes("claudeAgent") ? (
          <ClaudeAI className="size-3" aria-label="Claude Code" />
        ) : null}
      </span>
      <span className="flex size-4 items-center justify-center">
        {sources?.includes("codex") ? <OpenAI className="size-3" aria-label="Codex" /> : null}
      </span>
      <span className="text-right">{threadCount}</span>
      <span className="text-right whitespace-nowrap">{age}</span>
    </span>
  );
}

// ── Shared bits ──────────────────────────────────────────────

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}

function CommandBlock({
  command,
  className,
  prominent = false,
}: {
  readonly command: string;
  readonly className?: string;
  readonly prominent?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "command",
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 font-mono",
        prominent ? "px-4 py-3.5 text-base" : "px-3 py-2.5 text-sm",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        <span className="mr-2 text-muted-foreground">$</span>
        {command}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
