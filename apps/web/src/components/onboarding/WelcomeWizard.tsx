import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionProjectCandidate,
  EnvironmentId,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import { partitionOnboardingProjects } from "../../onboarding/projectImport.logic";
import {
  getOnboardingProviderState,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { resolveOnboardingTargetEnvironment } from "../../onboarding/targetEnvironment.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { newProjectId, randomUUID } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { agentSessionScan } from "../../state/agentSessions";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
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
  readonly onDone: () => void;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const [step, setStep] = useState<WizardStep>("connection");
  const [mode, setMode] = useState<ConnectionMode>("local");
  const [pairedEnvironmentId, setPairedEnvironmentId] = useState<EnvironmentId | null>(null);
  const targetEnvironment = useOnboardingTargetEnvironment(mode, pairedEnvironmentId);
  const stageIndex = step === "agents" ? 1 : step === "import" ? 2 : 0;
  const finish = useCallback(() => {
    completeOnboarding();
    onDone();
  }, [completeOnboarding, onDone]);

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-black text-white [--accent-foreground:#fff] [--accent:#171717] [--background:#000] [--border:#262626] [--card-foreground:#fff] [--card:#000] [--foreground:#fff] [--input:#262626] [--muted-foreground:#a1a1aa] [--muted:#171717] [--placeholder:#71717a] [--popover-foreground:#fff] [--popover:#171717] [--ring:#737373] [--secondary-foreground:#fff] [--secondary:#171717] [--terminal-background:#000] [--terminal-cursor:#fff] [--terminal-foreground:#fff] [--terminal-selection-background:rgb(255_255_255_/_0.2)] [color-scheme:dark]">
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto grid min-h-full w-full max-w-5xl content-center gap-10 px-6 py-12 sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-14 sm:px-10 lg:px-12">
          <aside className="flex min-w-0 flex-col justify-between sm:min-h-72">
            <nav aria-label="Setup progress" className="flex gap-5 sm:flex-col sm:gap-1">
              {ONBOARDING_STAGES.map((stage, index) => (
                <div
                  key={stage}
                  aria-current={index === stageIndex ? "step" : undefined}
                  className={cn(
                    "flex min-h-9 items-center gap-2.5 text-sm",
                    index < stageIndex
                      ? "text-emerald-400"
                      : index === stageIndex
                        ? "text-white"
                        : "text-white/35",
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
              <div className="mt-8 hidden items-center gap-2 text-xs text-white/55 sm:flex">
                <span className="size-1.5 rounded-full bg-emerald-400" />
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
      <h1 className="text-3xl font-semibold text-white sm:text-[34px]">Where is your code?</h1>
      <p className="mt-2.5 text-sm text-white/55">Choose where your agents will run.</p>
      <div className="mt-8 border-t border-white/12">
        {localAvailable ? (
          <ConnectionOption
            icon={MonitorIcon}
            title="This computer"
            description={localLabel}
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
  detail,
  selected,
  onSelect,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
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
        "group flex min-h-20 w-full cursor-pointer items-center gap-4 border-b border-white/12 px-1 py-3 text-left transition-colors",
        "outline-none focus-visible:bg-white/5 focus-visible:ring-1 focus-visible:ring-white/35",
        selected ? "text-white" : "text-white/70 hover:bg-white/[0.035] hover:text-white",
      )}
    >
      <Icon className={cn("size-[18px]", selected ? "text-emerald-400" : "text-white/40")} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block truncate text-xs text-white/50">{description}</span>
      </span>
      <span className="hidden text-xs text-white/45 sm:block">{detail}</span>
      {selected ? <CheckIcon className="size-4 text-emerald-400" /> : <span className="size-4" />}
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
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );
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
          <div className="mt-6 overflow-hidden border-y border-white/12">
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
              savedEnvironments={savedEnvironments}
              showSavedEnvironments
              empty={null}
            />
          </div>
          <Collapsible className="mt-4">
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-white/55 transition-colors hover:text-white">
              <ChevronRightIcon className="size-3.5 transition-transform duration-200 group-data-panel-open:rotate-90" />
              Add another machine
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <CommandBlock command={CONNECT_LOGIN_COMMAND} className="mt-2" />
            </CollapsiblePanel>
          </Collapsible>
          <div className="mt-7 flex justify-end">
            <Button onClick={onContinue}>Continue</Button>
          </div>
        </>
      ) : (
        <>
          <CommandBlock command={CONNECT_LOGIN_COMMAND} className="mt-7" prominent />
          <div className="mt-5 overflow-hidden border-y border-white/12">
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
              savedEnvironments={savedEnvironments}
              showSavedEnvironments
              empty={
                <p className="px-1 py-4 text-xs text-white/50">
                  Waiting for your computer to connect.
                </p>
              }
            />
          </div>
          <div className="mt-7 flex items-center justify-between">
            <Button variant="ghost" onClick={onContinue}>
              Skip for now
            </Button>
            <div className="flex items-center gap-3">
              <span className="hidden text-xs text-white/50 sm:block">Waiting for connection</span>
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
          <p className="text-sm text-white/65">
            <span className="font-mono text-white/40">01</span> Run this on your server
          </p>
          <CommandBlock command="npx t3 pair" className="mt-2" />
          <p className="mt-2 text-xs text-white/45">
            Add <code className="font-mono text-white/65">--tailscale</code> to use your tailnet.
          </p>
        </div>
        <div>
          <label className="block text-sm text-white/65" htmlFor="onboarding-pairing-url">
            <span className="font-mono text-white/40">02</span> Paste the pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            className="mt-2 border-white/15 bg-transparent text-white"
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

const AGENT_INSTALL_COMMANDS: Record<string, string> = {
  claudeAgent: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

// Claude has no `login` subcommand — running it interactively prompts OAuth.
const AGENT_LOGIN_COMMANDS: Record<string, string> = {
  claudeAgent: "claude",
  codex: "codex login",
};

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
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </StepShell>
    );
  }
  return (
    <ConnectedAgentsStep
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
  const [terminalAgent, setTerminalAgent] = useState<string | null>(null);

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
      <div className="mt-7 border-t border-white/12">
        {primaryAgents.map(({ driver, provider }) => (
          <AgentCard
            key={driver}
            driver={driver}
            provider={provider}
            terminalOpen={terminalAgent === driver}
            onOpenTerminal={() => setTerminalAgent(driver)}
          />
        ))}
      </div>
      {terminalAgent !== null ? (
        <AgentInstallTerminal
          key={terminalAgent}
          environmentId={environmentId}
          driver={terminalAgent}
          installed={byDriver.get(terminalAgent)?.installed ?? false}
          onClose={() => {
            setTerminalAgent(null);
            void refreshProviders({ environmentId, input: {} });
          }}
        />
      ) : null}
      <div className="mt-7 flex items-center justify-between gap-3">
        <Button className="text-white/60" variant="ghost" onClick={onSkip}>
          Skip
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/50">
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
  onOpenTerminal,
}: {
  readonly driver: string;
  readonly provider: ServerProvider | undefined;
  readonly terminalOpen: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const meta = getDriverOption(driver as never);
  const Icon = meta?.icon;
  const displayName = driver === "claudeAgent" ? "Claude Code" : (meta?.label ?? driver);
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="flex min-h-20 items-center gap-4 border-b border-white/12 py-3">
      {Icon ? (
        <Icon className={cn("size-6 shrink-0", driver !== "claudeAgent" && "fill-white")} />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-white">{displayName}</span>
        <p className="mt-1 truncate text-xs text-white/50">
          {summary.headline}
          {summary.detail ? ` · ${summary.detail}` : ""}
        </p>
      </div>
      <div className="shrink-0">
        {providerState === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : providerState === "checking" ? (
          <span className="text-xs text-white/45">Checking...</span>
        ) : providerState === "disabled" ? (
          <span className="text-xs text-white/45">Disabled</span>
        ) : providerState === "attention" ? (
          <span className="text-xs text-white/55">{summary.headline}</span>
        ) : (
          <Button size="xs" variant="ghost" onClick={onOpenTerminal} disabled={terminalOpen}>
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
  environmentId,
  driver,
  installed,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: string;
  readonly installed: boolean;
  readonly onClose: () => void;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  // Keybindings follow the machine the terminal runs on, not the primary.
  const keybindings = serverConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const preparedRef = useRef(false);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  // The terminal manager stats the cwd verbatim (no tilde expansion), so use
  // the server process's own working directory — always real on that machine.
  const cwd = serverConfig?.cwd ?? null;

  const command = installed
    ? (AGENT_LOGIN_COMMANDS[driver] ?? "")
    : (AGENT_INSTALL_COMMANDS[driver] ?? "");
  const [preTypeFailed, setPreTypeFailed] = useState(false);

  // Open + pre-type, and tear the PTY down again on cleanup. Both live in one
  // effect so a Strict Mode setup/cleanup/setup cycle (or any remount) always
  // re-opens: the previous run's session is closed and `preparedRef` is reset
  // together, instead of the ref surviving a teardown and leaving the drawer
  // attached to a dead session.
  useEffect(() => {
    if (cwd === null) return;
    let cancelled = false;
    if (!preparedRef.current) {
      preparedRef.current = true;
      void (async () => {
        const opened = await openTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, cwd },
        });
        // A transient RPC failure should retry rather than leave a dead
        // terminal, so only a successful open keeps the ref set.
        if (opened._tag !== "Success") {
          preparedRef.current = false;
          return;
        }
        // Cleanup may have run while the open was in flight — its close was a
        // no-op against a not-yet-created session, so reap the PTY here.
        if (cancelled) {
          void closeTerminal({
            environmentId,
            input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId },
          });
          return;
        }
        if (command.length === 0) return;
        // Pre-type without the trailing carriage return; the user submits.
        // The terminal id is unique to this mount, so this session has never
        // been written to before.
        const wrote = await writeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
        });
        // A silent failure would leave a blank prompt under copy that says
        // "review the command" — fall back to telling the user what to type.
        if (!cancelled && wrote._tag !== "Success") setPreTypeFailed(true);
      })();
    }
    // Every exit path unmounts the drawer (Done, Continue/Skip, card switch,
    // session exit), so this cleanup is the single place the PTY dies —
    // nothing is left running behind the wizard. An interrupted install is
    // re-runnable from the card.
    return () => {
      cancelled = true;
      preparedRef.current = false;
      void closeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId },
      });
    };
  }, [closeTerminal, command, cwd, environmentId, openTerminal, terminalId, writeTerminal]);

  if (cwd === null) {
    return null;
  }

  return (
    <div className="thread-terminal-drawer mt-4 overflow-hidden rounded-lg border border-border/70 bg-black text-white">
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {preTypeFailed ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : (
            "Review the command, then press Enter to run it."
          )}
        </span>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
      <div className="h-64">
        <TerminalViewport
          threadRef={threadRef}
          threadId={AGENT_ONBOARDING_THREAD_ID}
          terminalId={terminalId}
          terminalLabel={`Install ${driver}`}
          cwd={cwd}
          advancedTypography={advancedTypography}
          onSessionExited={onClose}
          onAddTerminalContext={() => undefined}
          focusRequestId={1}
          autoFocus
          resizeEpoch={0}
          drawerHeight={256}
          keybindings={keybindings}
        />
      </div>
    </div>
  );
}

// ── Step 4: import ───────────────────────────────────────────

/**
 * One-decision import (4B): a summary line with Import recent / Choose /
 * Skip. The default imports only projects touched in the last 30 days;
 * Choose expands a checklist including older ones. Projects only — thread
 * history import is a follow-up.
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
  readonly onDone: () => void;
}) {
  const targetEnvironment = useOnboardingTargetEnvironment(mode, pairedEnvironmentId);
  const environmentId = targetEnvironment?.environmentId ?? null;
  const machineLabel = targetEnvironment?.label ?? "this machine";
  const providers = useAtomValue(
    serverEnvironment.providersValueAtom(environmentId ?? ("" as EnvironmentId)),
  );
  const scan = useEnvironmentQuery(
    environmentId === null ? null : agentSessionScan({ environmentId, input: {} }),
  );
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const [choosing, setChoosing] = useState(false);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  // Paths that already imported this session, so a retry after a partial
  // failure skips them instead of tripping the duplicate-root invariant.
  const importedPathsRef = useRef(new Set<string>());
  const importGenerationRef = useRef(0);

  // Candidate paths are per-environment; a target switch would otherwise
  // leave stale entries in the deselection set (and stale success records).
  useEffect(() => {
    importGenerationRef.current += 1;
    setDeselected(new Set());
    setIsImporting(false);
    setImportError("");
    importedPathsRef.current = new Set();
    return () => {
      importGenerationRef.current += 1;
    };
  }, [environmentId]);

  const {
    available: candidates,
    recent,
    alreadyImportedCount,
  } = useMemo(() => partitionOnboardingProjects(scan.data?.candidates ?? []), [scan.data]);
  const older = candidates.length - recent.length;

  const runImport = async (selection: ReadonlyArray<AgentSessionProjectCandidate>) => {
    if (environmentId === null || selection.length === 0) {
      onDone();
      return;
    }
    setIsImporting(true);
    setImportError("");
    const importGeneration = importGenerationRef.current;
    const importedPaths = importedPathsRef.current;
    const defaultModelSelection = resolveDefaultProviderModelSelection(providers ?? [], null);
    // Interrupted imports are neither failures nor successes — the command was
    // superseded or the environment dropped — but they still didn't land, so
    // they must not read as "imported everything". Retries skip paths that
    // already landed this session (re-creating them would only trip the
    // duplicate-root invariant and read as a failure).
    let imported =
      importedPaths.size > 0
        ? selection.filter((candidate) => importedPaths.has(candidate.path)).length
        : 0;
    for (const candidate of selection) {
      if (
        importGeneration !== importGenerationRef.current ||
        importedPaths !== importedPathsRef.current
      ) {
        return;
      }
      if (importedPaths.has(candidate.path)) continue;
      const result = await createProject({
        environmentId,
        input: {
          projectId: newProjectId(),
          title: candidate.title,
          workspaceRoot: candidate.path,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection,
        },
      });
      if (
        importGeneration !== importGenerationRef.current ||
        importedPaths !== importedPathsRef.current
      ) {
        return;
      }
      if (result._tag === "Success") {
        imported += 1;
        importedPaths.add(candidate.path);
      }
    }
    setIsImporting(false);
    if (imported < selection.length) {
      setImportError(
        imported === 0
          ? "Import failed. You can add projects manually from the command palette."
          : `Imported ${imported} of ${selection.length} projects. The rest can be added from the command palette.`,
      );
      return;
    }
    onDone();
  };

  if (environmentId === null || (scan.isPending && scan.data === null)) {
    return (
      <StepShell
        title="Your projects"
        description="Looking for projects from Claude Code and Codex."
        onBack={onBack}
      >
        <div className="mt-6 flex justify-end">
          <Button variant="ghost" onClick={onDone}>
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
            : alreadyImportedCount > 0
              ? "Your existing projects are already in T3 Code."
              : "No existing Claude Code or Codex projects found."
        }
        onBack={onBack}
      >
        {scan.error !== null ? (
          <p className="mt-3 text-xs text-white/50">You can add projects later.</p>
        ) : null}
        <div className="mt-6 flex justify-end">
          <Button onClick={onDone}>Start coding</Button>
        </div>
      </StepShell>
    );
  }

  if (choosing) {
    const selectedCount = candidates.length - deselected.size;
    return (
      <StepShell
        title="Choose your projects"
        onBack={() => setChoosing(false)}
        description={`${candidates.length} found on ${machineLabel}.`}
      >
        <div className="mt-6 max-h-72 overflow-x-hidden overflow-y-auto border-y border-white/12">
          {candidates.map((candidate) => (
            <label
              key={candidate.path}
              className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-white/8 px-1 py-2 last:border-b-0 hover:bg-white/[0.035]"
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
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-white/85">
                {candidate.path}
              </span>
              <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-white/45 sm:block">
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
        <div className="mt-7 flex items-center justify-between">
          <Button variant="ghost" disabled={isImporting} onClick={onDone}>
            Skip
          </Button>
          <Button
            disabled={isImporting || selectedCount === 0}
            onClick={() =>
              void runImport(candidates.filter((candidate) => !deselected.has(candidate.path)))
            }
          >
            {isImporting ? "Importing..." : `Import ${selectedCount}`}
          </Button>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      title="Your recent projects"
      description={`${recent.length} ${recent.length === 1 ? "project" : "projects"} found on ${machineLabel}.${older > 0 ? ` ${older} older available.` : ""}`}
      onBack={onBack}
    >
      <div className="mt-6 border-y border-white/12">
        {recent.slice(0, 4).map((candidate) => (
          <div
            key={candidate.path}
            className="flex min-h-12 items-center gap-3 border-b border-white/8 px-1 py-2 last:border-b-0"
          >
            <CheckIcon className="size-3.5 shrink-0 text-emerald-400" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-white/85">
              {candidate.path}
            </span>
            <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-white/45 sm:block">
              {candidate.sources.map(formatSource).join(", ")}
            </span>
          </div>
        ))}
        {recent.length > 4 ? (
          <p className="px-1 py-3 text-xs text-white/45">{recent.length - 4} more projects</p>
        ) : null}
      </div>
      {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <Button className="text-white/60" variant="ghost" disabled={isImporting} onClick={onDone}>
          Skip
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
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly onBack?: () => void;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      {onBack ? (
        <Button
          className="mb-5 -ml-2 text-white/55 hover:text-white"
          onClick={onBack}
          size="xs"
          variant="ghost-muted"
        >
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Button>
      ) : null}
      <h1 className="text-3xl font-semibold text-white sm:text-[34px]">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-white/55">{description}</p>
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
  // Plain HTTP has no Clipboard API, so its fallback must run during the click gesture.
  const [fallbackCopied, setFallbackCopied] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "command",
  });
  useEffect(() => {
    if (!fallbackCopied) return;
    const timer = window.setTimeout(() => setFallbackCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [fallbackCopied]);
  const copied = isCopied || fallbackCopied;
  const copyCommand = () => {
    if (typeof navigator.clipboard !== "undefined") {
      copyToClipboard(command, undefined);
      return;
    }

    const scratch = document.createElement("textarea");
    scratch.value = command;
    scratch.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.append(scratch);
    scratch.select();
    const didCopy = document.execCommand("copy");
    scratch.remove();
    if (didCopy) setFallbackCopied(true);
  };
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border border-white/15 bg-white/[0.035] font-mono",
        prominent ? "px-4 py-3.5 text-base" : "px-3 py-2.5 text-sm",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        <span className="mr-2 text-muted-foreground">$</span>
        {command}
      </span>
      <Button size="icon-xs" variant="ghost" aria-label="Copy command" onClick={copyCommand}>
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

function formatSource(source: "claudeAgent" | "codex"): string {
  return source === "claudeAgent" ? "Claude" : "Codex";
}
