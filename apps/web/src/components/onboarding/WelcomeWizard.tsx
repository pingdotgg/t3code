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
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudIcon,
  CopyIcon,
  LinkIcon,
  MonitorIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { mountOnboardingTheme } from "../../hooks/useTheme";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  partitionOnboardingProjects,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
} from "../../onboarding/projectImport.logic";
import {
  getOnboardingProviderState,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import {
  isOnboardingRelayEnvironment,
  resolveOnboardingTargetEnvironment,
} from "../../onboarding/targetEnvironment.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { newProjectId, randomUUID } from "../../lib/utils";
import { agentSessionImport, agentSessionScan } from "../../state/agentSessions";
import { readProjects, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { isElectron } from "../../env";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";

/**
 * First-run welcome wizard. Rendered as the full-screen `/welcome` route on a
 * fresh install (no completed-onboarding flag, empty workspace). Flow per the
 * onboarding overhaul spec: connection choice → sign-in/pair (remote paths) →
 * agent setup with inline install terminal → project import → main screen.
 * Every step past the connection gate is skippable; the whole wizard is
 * re-runnable by clearing the flag.
 */

type WizardStep = "connection" | "connect-machines" | "pair-direct" | "agents" | "import";

type ConnectionMode = "local" | "connect" | "direct";

/**
 * The machine the agent and import steps run against. Local mode targets the
 * primary environment; the remote modes prefer the machine the user just
 * connected (the most recently added connected non-primary environment), so
 * probing and import happen where their code lives rather than on the local
 * server that happens to serve the app. Deliberately not a persisted
 * "primary machine" concept — just whichever machine fits the chosen path
 * right now, labeled inline on each step.
 */
function useOnboardingTargetEnvironment(
  mode: ConnectionMode,
  pairedEnvironmentId: EnvironmentId | null,
) {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  return resolveOnboardingTargetEnvironment({
    mode,
    environments,
    primaryEnvironment,
    pairedEnvironmentId,
  });
}

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const ONBOARDING_STAGES = ["Connect", "Agents", "Projects"] as const;
const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";

export function WelcomeWizard({
  localAvailable,
  onDone,
}: {
  /**
   * Whether the "Local Only" card is offered. True whenever the app is served
   * by an authenticated primary server — desktop, `npx t3`, or a dev server —
   * since that server is "this machine" regardless of the hostname the app
   * was opened from. Only hosted-static (app.t3.codes) has no local server.
   */
  readonly localAvailable: boolean;
  readonly onDone: (projectRef?: ScopedProjectRef) => void;
}) {
  useLayoutEffect(() => mountOnboardingTheme(), []);
  const completeOnboarding = useCompleteOnboarding();
  const [step, setStep] = useState<WizardStep>("connection");
  const [mode, setMode] = useState<ConnectionMode>("local");
  const [pairedEnvironmentId, setPairedEnvironmentId] = useState<EnvironmentId | null>(null);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const targetEnvironment = useOnboardingTargetEnvironment(mode, pairedEnvironmentId);
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
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-black text-foreground">
      {isElectron ? (
        <div
          aria-hidden
          className="drag-region h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 wco:pr-[var(--workspace-native-controls-inset)]"
        />
      ) : null}
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto grid min-h-full w-full max-w-5xl content-center gap-10 px-6 py-12 sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-14 sm:px-10 lg:px-12">
          <aside className="flex min-w-0 flex-col justify-between sm:min-h-72">
            <nav
              aria-label="Setup progress"
              className="flex flex-wrap gap-x-5 gap-y-1 sm:flex-col sm:gap-1"
            >
              {ONBOARDING_STAGES.map((stage, index) => (
                <div
                  key={stage}
                  aria-current={index === stageIndex ? "step" : undefined}
                  className={cn(
                    "flex min-h-9 items-center gap-2.5 text-sm",
                    index < stageIndex
                      ? "text-success-foreground"
                      : index === stageIndex
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                  )}
                >
                  {index < stageIndex ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <span className="w-3.5 font-mono text-xs">0{index + 1}</span>
                  )}
                  <span>{stage}</span>
                </div>
              ))}
            </nav>
            {targetEnvironment ? (
              <div className="mt-8 hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                <span className="size-1.5 rounded-full bg-success" />
                <span className="truncate">{targetEnvironment.label}</span>
              </div>
            ) : null}
          </aside>

          <section className="min-w-0">
            {step === "connection" ? (
              <ConnectionStep
                localAvailable={localAvailable}
                localLabel={targetEnvironment?.label ?? "This computer"}
                onLocal={() => {
                  setMode("local");
                  setPairedEnvironmentId(null);
                  setStep("agents");
                }}
                onConnect={() => {
                  setMode("connect");
                  setPairedEnvironmentId(null);
                  setStep("connect-machines");
                }}
                onDirect={() => {
                  setMode("direct");
                  setPairedEnvironmentId(null);
                  setStep("pair-direct");
                }}
              />
            ) : step === "connect-machines" ? (
              <ConnectMachinesStep
                onBack={() => setStep("connection")}
                onContinue={() => setStep("agents")}
              />
            ) : step === "pair-direct" ? (
              <PairDirectStep
                onBack={() => setStep("connection")}
                onPaired={(environmentId) => {
                  setPairedEnvironmentId(environmentId);
                  setStep("agents");
                }}
              />
            ) : step === "agents" ? (
              <AgentsStep
                mode={mode}
                pairedEnvironmentId={pairedEnvironmentId}
                onBack={() =>
                  setStep(
                    mode === "local"
                      ? "connection"
                      : mode === "connect"
                        ? "connect-machines"
                        : "pair-direct",
                  )
                }
                onContinue={() => setStep("import")}
                onSkip={() => setStep("import")}
              />
            ) : (
              <ImportStep
                mode={mode}
                pairedEnvironmentId={pairedEnvironmentId}
                onBack={() => setStep("agents")}
                onDone={finish}
              />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// ── Step 1: connection choice ────────────────────────────────

function ConnectionStep({
  localAvailable,
  localLabel,
  onLocal,
  onConnect,
  onDirect,
}: {
  readonly localAvailable: boolean;
  readonly localLabel: string;
  readonly onLocal: () => void;
  readonly onConnect: () => void;
  readonly onDirect: () => void;
}) {
  const cloudEnabled = hasCloudPublicConfig();
  const [choice, setChoice] = useState<"local" | "connect" | "direct">(
    localAvailable ? "local" : cloudEnabled ? "connect" : "direct",
  );

  const advance = () => {
    if (choice === "local") onLocal();
    else if (choice === "connect") onConnect();
    else onDirect();
  };

  return (
    <>
      <h1 className="text-3xl font-semibold text-foreground sm:text-[34px]">Where is your code?</h1>
      <p className="mt-2.5 text-sm text-muted-foreground">Choose where your agents will run.</p>
      <div className="mt-8 border-t border-border">
        {localAvailable ? (
          <ConnectionOption
            icon={MonitorIcon}
            title="This computer"
            description={localLabel}
            truncateDescription
            detail="No account"
            selected={choice === "local"}
            onSelect={() => setChoice("local")}
          />
        ) : null}
        {cloudEnabled ? (
          <ConnectionOption
            icon={CloudIcon}
            title="T3 Connect"
            description="Your computers, wherever you are"
            detail="Sign in"
            selected={choice === "connect"}
            onSelect={() => setChoice("connect")}
          />
        ) : null}
        <ConnectionOption
          icon={LinkIcon}
          title="Pair a server"
          description="Local network or Tailscale"
          detail="Pairing link"
          selected={choice === "direct"}
          onSelect={() => setChoice("direct")}
        />
      </div>
      <div className="mt-7 flex justify-end">
        <Button className="gap-2" onClick={advance}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function ConnectionOption({
  icon: Icon,
  title,
  description,
  truncateDescription = false,
  detail,
  selected,
  onSelect,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly truncateDescription?: boolean;
  readonly detail: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group flex min-h-20 w-full cursor-pointer items-center gap-4 border-b border-border px-1 py-3 text-left transition-colors",
        "outline-none focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <Icon
        className={cn("size-[18px]", selected ? "text-success-foreground" : "text-icon-muted")}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span
          className={cn(
            "mt-1 block text-xs text-muted-foreground",
            truncateDescription ? "truncate" : "break-words whitespace-normal",
          )}
        >
          {description}
        </span>
      </span>
      <span className="hidden text-xs text-muted-foreground sm:block">{detail}</span>
      {selected ? (
        <CheckIcon className="size-4 text-success-foreground" />
      ) : (
        <span className="size-4" />
      )}
    </button>
  );
}

// ── Step 2: T3 Connect (sign in, then connect machines) ──────

const CONNECT_LOGIN_COMMAND = "npx t3 connect";

/**
 * Sign-in and machine-connection combined: signed out shows the Clerk prompt,
 * signed in forks on account state — zero connected machines blocks on the
 * `npx t3 connect` command and auto-advance is left to the user pressing
 * Continue once their machine appears; existing machines show a confirmation
 * list with the command folded away. There is deliberately no "primary
 * machine" selection.
 */
function ConnectMachinesStep({
  onBack,
  onContinue,
}: {
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  // Mirrors ManagedRelayAuthProvider: a pending Clerk session must not read
  // as signed-out mid-transition.
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironments = environments.filter(isOnboardingRelayEnvironment);
  // Only a live connection counts: a saved-but-offline machine must not show
  // the "connected" confirmation (the agents step would find nothing to
  // probe). Its row still renders in the list either way.
  const hasRemoteMachines = savedEnvironments.some(
    (environment) => environment.connection.phase === "connected",
  );

  if (!isLoaded) {
    return <StepShell title="Sign in to T3 Connect" onBack={onBack} />;
  }

  if (!isSignedIn) {
    return (
      <StepShell
        title="Sign in to T3 Connect"
        description="Connect your computers with one account."
        onBack={onBack}
      >
        <div className="mt-6">
          <Button onClick={openAuthPrompt}>Sign in</Button>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      title={hasRemoteMachines ? "Your computers" : "Connect your computer"}
      description={
        hasRemoteMachines
          ? "Connected to your T3 account."
          : "Run this command on the computer with your code."
      }
      onBack={onBack}
    >
      {hasRemoteMachines ? (
        <>
          <div className="mt-6 overflow-hidden border-y border-border">
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
              savedEnvironments={savedEnvironments}
              showSavedEnvironments
              empty={null}
            />
          </div>
          <Collapsible className="mt-4">
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRightIcon className="size-3.5 transition-transform duration-200 group-data-panel-open:rotate-90" />
              Add another machine
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <CommandBlock command={CONNECT_LOGIN_COMMAND} className="mt-2" />
              <p className="mt-2 text-xs text-muted-foreground">
                Keep T3 Code running on that computer. If it is not running, open T3 Code or run{" "}
                <code className="font-mono">npx t3 serve</code>.
              </p>
            </CollapsiblePanel>
          </Collapsible>
          <div className="mt-7 flex justify-end">
            <Button onClick={onContinue}>Continue</Button>
          </div>
        </>
      ) : (
        <>
          <CommandBlock command={CONNECT_LOGIN_COMMAND} className="mt-7" prominent />
          <p className="mt-2 text-xs text-muted-foreground">
            Keep T3 Code running on that computer. If it is not running, open T3 Code or run{" "}
            <code className="font-mono">npx t3 serve</code>.
          </p>
          <div className="mt-5 overflow-hidden border-y border-border">
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
              savedEnvironments={savedEnvironments}
              showSavedEnvironments
              refreshWhileEmpty
              empty={
                <p className="px-1 py-4 text-xs text-muted-foreground">
                  Waiting for your computer to connect.
                </p>
              }
            />
          </div>
          <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost-muted" onClick={onContinue}>
              Skip for now
            </Button>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span className="hidden text-xs text-muted-foreground sm:block">
                Waiting for connection
              </span>
              <Button disabled>Continue</Button>
            </div>
          </div>
        </>
      )}
    </StepShell>
  );
}

// ── Step 2′: Direct pairing ──────────────────────────────────

/**
 * Server-minted pairing, D-B treatment: numbered steps, `t3 pair` on the
 * server, paste the URL here. Registers the remote environment in this
 * browser's catalog (same path the hosted /pair surface uses).
 */
function PairDirectStep({
  onBack,
  onPaired,
}: {
  readonly onBack: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl });
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
    <StepShell
      title="Pair a server"
      description="Connect with a one-time pairing link."
      onBack={onBack}
    >
      <div className="mt-7 space-y-5">
        <div>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono text-muted-foreground/70">01</span> Run this on your server
          </p>
          <CommandBlock command="npx t3 pair" className="mt-2" />
          <p className="mt-2 text-xs text-muted-foreground">
            Start the server with <code className="font-mono">npx t3 serve</code> first. Add{" "}
            <code className="font-mono">--tailscale</code> to use your tailnet.
          </p>
        </div>
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            <span className="font-mono text-muted-foreground/70">02</span> Paste the pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            className="mt-2"
            size="lg"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            nativeInput
            disabled={isPairing}
            placeholder="https://your-server:5230/pair#token=…"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter" && pairingUrl.trim().length > 0) void submit();
            }}
          />
        </div>
        {errorMessage ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}
      </div>
      <div className="mt-7 flex justify-end">
        <Button
          disabled={isPairing || pairingUrl.trim().length === 0}
          onClick={() => void submit()}
        >
          {isPairing ? "Pairing..." : "Connect"}
        </Button>
      </div>
    </StepShell>
  );
}

// ── Step 3: agents ───────────────────────────────────────────

const PRIMARY_AGENT_DRIVERS = ["claudeAgent", "codex"] as const;
type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

const AGENT_INSTALL_COMMANDS: Record<OnboardingAgentDriver, string> = {
  claudeAgent: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

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
 * Claude Code and Codex use live probe status. Install opens the built-in terminal inline
 * with the command pre-typed — the update RPC can't install a binary that
 * isn't there yet (it infers the package manager from the installed binary's
 * path), and the terminal also handles the interactive login that follows.
 */
function AgentsStep({
  mode,
  pairedEnvironmentId,
  onBack,
  onContinue,
  onSkip,
}: {
  readonly mode: ConnectionMode;
  readonly pairedEnvironmentId: EnvironmentId | null;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onSkip: () => void;
}) {
  const targetEnvironment = useOnboardingTargetEnvironment(mode, pairedEnvironmentId);
  if (targetEnvironment === null) {
    return (
      <StepShell
        title="Your agents"
        description="Waiting for this computer to connect."
        onBack={onBack}
      >
        <div className="mt-6 flex justify-end">
          <Button variant="ghost-muted" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </StepShell>
    );
  }
  return (
    <ConnectedAgentsStep
      key={targetEnvironment.environmentId}
      environmentId={targetEnvironment.environmentId}
      machineLabel={targetEnvironment.label}
      onBack={onBack}
      onContinue={onContinue}
      onSkip={onSkip}
    />
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
  onBack,
  onContinue,
  onSkip,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onSkip: () => void;
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
  const readyCount = primaryAgents.filter(
    ({ provider }) => getOnboardingProviderState(provider) === "ready",
  ).length;
  return (
    <StepShell title="Your agents" description={`Detected on ${machineLabel}.`} onBack={onBack}>
      <div className="mt-7 border-t border-border">
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
                  : AGENT_INSTALL_COMMANDS[driver],
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
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost-muted" onClick={onSkip}>
          Skip
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="text-xs text-muted-foreground">
            {readyCount} of {primaryAgents.length} ready
          </span>
          <Button className="gap-2" onClick={onContinue}>
            Continue
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </StepShell>
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
    <div className="flex min-h-20 items-center gap-4 border-b border-border py-3">
      {Icon ? (
        <Icon className={cn("size-6 shrink-0", driver !== "claudeAgent" && "fill-foreground")} />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        <p className="mt-1 truncate text-xs text-muted-foreground">
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

/**
 * One-decision import (4B): a summary line with Import recent / Choose /
 * Skip. The default imports only projects touched in the last 30 days;
 * Choose expands a checklist including older ones. Imported projects also
 * receive Codex and Claude threads active within the last 30 days.
 */
function ImportStep({
  mode,
  pairedEnvironmentId,
  onBack,
  onDone,
}: {
  readonly mode: ConnectionMode;
  readonly pairedEnvironmentId: EnvironmentId | null;
  readonly onBack: () => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
}) {
  const targetEnvironment = useOnboardingTargetEnvironment(mode, pairedEnvironmentId);
  const environmentId = targetEnvironment?.environmentId ?? null;
  const machineLabel = targetEnvironment?.label ?? "this machine";
  const scan = useEnvironmentQuery(
    environmentId === null ? null : agentSessionScan({ environmentId, input: {} }),
  );
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const projects = useProjects();
  const [choosing, setChoosing] = useState(false);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
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

  // Candidate paths are per-environment; a target switch would otherwise
  // leave stale entries in the deselection set (and stale success records).
  useEffect(() => {
    importGenerationRef.current += 1;
    setDeselected(new Set());
    setIsImporting(false);
    setImportError("");
    setLandingProject(null);
    importedProjectsRef.current = new Map();
    projectsWithImportedHistoryRef.current = new Map();
    lastImportSelectionRef.current = [];
    projectAttemptsRef.current = new Map();
    return () => {
      importGenerationRef.current += 1;
    };
  }, [environmentId]);

  useEffect(() => {
    if (
      landingProject !== null &&
      landingProject.environmentId === environmentId &&
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
  }, [environmentId, landingProject, onDone, projects]);

  const { available: candidates, recent } = useMemo(
    () => partitionOnboardingProjects(scan.data?.candidates ?? []),
    [scan.data],
  );
  const more = candidates.length - recent.length;
  const scanTruncated = scan.data?.truncated === true;
  const scanLimitNotice = scanTruncated ? (
    <p className="mt-3 text-sm text-muted-foreground" role="status">
      {SCAN_LIMIT_MESSAGE}
    </p>
  ) : null;

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

  const runImport = async (selection: ReadonlyArray<AgentSessionProjectCandidate>) => {
    if (environmentId === null || selection.length === 0) {
      void onDone();
      return;
    }
    setIsImporting(true);
    setImportError("");
    lastImportSelectionRef.current = selection.map((candidate) => candidate.path);
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
        ? selection.filter((candidate) => importedProjects.has(candidate.path)).length
        : 0;
    let importedThreadCount = 0;
    let skippedThreadCount = 0;
    let shouldRefreshScan = false;
    for (const candidate of selection) {
      if (
        importGeneration !== importGenerationRef.current ||
        importedProjects !== importedProjectsRef.current
      ) {
        return;
      }
      if (importedProjects.has(candidate.path)) continue;
      let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
      if (projectId === null) {
        let attempt = projectAttempts.get(candidate.path);
        if (attempt === undefined) {
          const nextProjectId = newProjectId();
          attempt = {
            projectId: nextProjectId,
            commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
          };
          projectAttempts.set(candidate.path, attempt);
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
            projectAttempts.delete(candidate.path);
            shouldRefreshScan = true;
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
            candidate.path,
            scopeProjectRef(environmentId, projectId),
          );
        }
        if (threadImportResult.value.skippedCount === 0) {
          importedProjectsCount += 1;
          importedProjects.set(candidate.path, scopeProjectRef(environmentId, projectId));
        }
      } else if (!isAtomCommandInterrupted(threadImportResult)) {
        projectAttempts.delete(candidate.path);
        shouldRefreshScan = true;
      }
    }
    if (shouldRefreshScan) scan.refresh();
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

  if (environmentId === null || (scan.isPending && scan.data === null)) {
    return (
      <StepShell
        title="Your projects"
        description="Looking for projects from Claude Code and Codex."
        onBack={onBack}
      >
        <div className="mt-6 flex justify-end">
          <Button variant="ghost-muted" onClick={() => void onDone()}>
            Skip
          </Button>
        </div>
      </StepShell>
    );
  }

  if (scan.error !== null || candidates.length === 0) {
    return (
      <StepShell
        title="Your projects"
        description={
          scan.error !== null
            ? "Could not check this computer for projects."
            : scanTruncated
              ? SCAN_LIMIT_MESSAGE
              : "No existing Claude Code or Codex projects found."
        }
        onBack={onBack}
      >
        {scan.error !== null ? (
          <p className="mt-3 text-xs text-muted-foreground">You can add projects later.</p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          {scan.error !== null ? (
            <Button variant="ghost" onClick={scan.refresh}>
              Retry
            </Button>
          ) : null}
          <Button
            variant={scan.error !== null || scanTruncated ? "ghost-muted" : "default"}
            onClick={() => void onDone()}
          >
            {scan.error !== null || scanTruncated ? "Skip" : "Start coding"}
          </Button>
        </div>
      </StepShell>
    );
  }

  if (choosing) {
    const selected = candidates.filter((candidate) => !deselected.has(candidate.path));
    return (
      <StepShell
        title="Choose your projects"
        onBack={() => setChoosing(false)}
        backDisabled={isImporting}
        description={`${candidates.length} found on ${machineLabel}.`}
      >
        {scanLimitNotice}
        <div className="mt-6 max-h-72 overflow-x-hidden overflow-y-auto border-y border-border">
          {candidates.map((candidate) => (
            <label
              key={candidate.path}
              className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-border/60 px-1 py-2 last:border-b-0 hover:bg-accent/50"
            >
              <Checkbox
                checked={!deselected.has(candidate.path)}
                onCheckedChange={(checked) => {
                  setDeselected((previous) => {
                    const next = new Set(previous);
                    if (checked === true) next.delete(candidate.path);
                    else next.add(candidate.path);
                    return next;
                  });
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {candidate.path}
              </span>
              <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground sm:block">
                {candidate.sources.map(formatSource).join(", ")} · {candidate.threadCount}{" "}
                {candidate.threadCount === 1 ? "thread" : "threads"}
                {candidate.lastActiveAt
                  ? ` · ${formatRelativeTimeLabel(candidate.lastActiveAt)}`
                  : ""}
              </span>
            </label>
          ))}
        </div>
        {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
        <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost-muted"
            disabled={isImporting}
            onClick={importError ? finishAfterImport : () => void onDone()}
          >
            {importError ? "Continue without the rest" : "Skip"}
          </Button>
          <Button
            disabled={isImporting || selected.length === 0}
            onClick={() => void runImport(selected)}
          >
            {isImporting ? "Importing..." : `Import ${selected.length}`}
          </Button>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      title="Your recent projects"
      description={`${recent.length} ${recent.length === 1 ? "project" : "projects"} found on ${machineLabel}.${more > 0 ? ` ${more} more available.` : ""}`}
      onBack={onBack}
      backDisabled={isImporting}
    >
      {scanLimitNotice}
      <div className="mt-6 border-y border-border">
        {recent.slice(0, 4).map((candidate) => (
          <div
            key={candidate.path}
            className="flex min-h-12 items-center gap-3 border-b border-border/60 px-1 py-2 last:border-b-0"
          >
            <CheckIcon className="size-3.5 shrink-0 text-success-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {candidate.path}
            </span>
            <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground sm:block">
              {candidate.sources.map(formatSource).join(", ")}
            </span>
          </div>
        ))}
        {recent.length > 4 ? (
          <p className="px-1 py-3 text-xs text-muted-foreground">
            {recent.length - 4} more projects
          </p>
        ) : null}
      </div>
      {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost-muted"
          disabled={isImporting}
          onClick={importError ? finishAfterImport : () => void onDone()}
        >
          {importError ? "Continue without the rest" : "Skip"}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled={isImporting} onClick={() => setChoosing(true)}>
            Choose
          </Button>
          <Button
            disabled={isImporting || recent.length === 0}
            onClick={() => void runImport(recent)}
          >
            {isImporting
              ? "Importing..."
              : `Import ${recent.length} ${recent.length === 1 ? "project" : "projects"}`}
          </Button>
        </div>
      </div>
    </StepShell>
  );
}

// ── Shared bits ──────────────────────────────────────────────

function StepShell({
  title,
  description,
  onBack,
  backDisabled = false,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly onBack?: () => void;
  readonly backDisabled?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      {onBack ? (
        <Button
          className="mb-5 -ml-2"
          disabled={backDisabled}
          onClick={onBack}
          size="xs"
          variant="ghost-muted"
        >
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Button>
      ) : null}
      <h1 className="text-3xl font-semibold text-foreground sm:text-[34px]">{title}</h1>
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
        "flex items-center justify-between gap-3 border border-border bg-accent/50 font-mono",
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

function formatSource(source: "claudeAgent" | "codex"): string {
  return source === "claudeAgent" ? "Claude" : "Codex";
}
