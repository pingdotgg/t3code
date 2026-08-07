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
import { CheckIcon, ChevronLeftIcon, CopyIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { APP_DISPLAY_NAME } from "../../branding";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import { newProjectId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { agentSessionScan } from "../../state/agentSessions";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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

/**
 * The machine the agent and import steps run against: the primary environment
 * when it's connected, otherwise the first connected environment (the remote
 * paths on web/hosted have no primary). Deliberately not a persisted "primary
 * machine" concept — just whichever machine is reachable right now, labeled
 * inline on each step.
 */
function useOnboardingTargetEnvironment() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  if (primaryEnvironment !== null && primaryEnvironment.connection.phase === "connected") {
    return primaryEnvironment;
  }
  return environments.find((environment) => environment.connection.phase === "connected") ?? null;
}

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const IMPORT_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
  const finish = useCallback(() => {
    completeOnboarding();
    onDone();
  }, [completeOnboarding, onDone]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-emerald-500)_14%,transparent),transparent)]" />
        <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-2xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        {step === "connection" ? (
          <ConnectionStep
            localAvailable={localAvailable}
            onLocal={() => setStep("agents")}
            onConnect={() => setStep("connect-machines")}
            onDirect={() => setStep("pair-direct")}
          />
        ) : step === "connect-machines" ? (
          <ConnectMachinesStep
            onBack={() => setStep("connection")}
            onContinue={() => setStep("agents")}
          />
        ) : step === "pair-direct" ? (
          <PairDirectStep onBack={() => setStep("connection")} onPaired={() => setStep("agents")} />
        ) : step === "agents" ? (
          <AgentsStep onContinue={() => setStep("import")} onSkip={() => setStep("import")} />
        ) : (
          <ImportStep onDone={finish} />
        )}
      </section>
    </div>
  );
}

// ── Step 1: connection choice ────────────────────────────────

function ConnectionStep({
  localAvailable,
  onLocal,
  onConnect,
  onDirect,
}: {
  readonly localAvailable: boolean;
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
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        How do you want to connect?
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Choose where your agents run. You can add more connections later in Settings.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {localAvailable ? (
          <ConnectionCard
            title="Local Only"
            description="Use T3 Code with agents on this machine."
            tag="no account"
            selected={choice === "local"}
            onSelect={() => setChoice("local")}
          />
        ) : null}
        {cloudEnabled ? (
          <ConnectionCard
            title="T3 Connect"
            description="Sign in and connect to any of your computers."
            tag="account"
            selected={choice === "connect"}
            onSelect={() => setChoice("connect")}
          />
        ) : null}
        <ConnectionCard
          title="Direct"
          description="Connect to a server by URL. Works over LAN and Tailscale."
          tag="advanced"
          selected={choice === "direct"}
          onSelect={() => setChoice("direct")}
        />
      </div>
      <div className="mt-6 flex justify-end">
        <Button onClick={advance}>Continue</Button>
      </div>
    </>
  );
}

function ConnectionCard({
  title,
  description,
  tag,
  selected,
  onSelect,
}: {
  readonly title: string;
  readonly description: string;
  readonly tag: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex flex-col rounded-xl border p-4 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/25"
          : "border-border/70 bg-background/40 hover:border-border",
      )}
    >
      <span className="text-sm font-semibold">{title}</span>
      <span className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">
        {description}
      </span>
      <span className="mt-3 self-start rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {tag}
      </span>
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
        description="One account links all your machines. Machines signed into your account connect automatically."
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
      title={hasRemoteMachines ? "Your machines are connected" : "Run this where your code lives"}
      description={
        hasRemoteMachines
          ? "These machines connected automatically from your account."
          : "SSH in if you need to. The machine signs into your account and connects on its own."
      }
      onBack={onBack}
    >
      {hasRemoteMachines ? (
        <>
          <div className="mt-5 overflow-hidden rounded-lg border">
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
              savedEnvironments={savedEnvironments}
              showSavedEnvironments
              empty={null}
            />
          </div>
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Add another machine
            </summary>
            <CommandBlock command={CONNECT_LOGIN_COMMAND} className="mt-2" />
          </details>
          <div className="mt-6 flex justify-end">
            <Button onClick={onContinue}>Continue</Button>
          </div>
        </>
      ) : (
        <>
          <CommandBlock command={CONNECT_LOGIN_COMMAND} className="mt-6" prominent />
          <div className="mt-5 overflow-hidden rounded-lg border border-dashed border-border/60">
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
              savedEnvironments={savedEnvironments}
              showSavedEnvironments
              empty={
                <p className="px-4 py-4 text-center text-xs text-muted-foreground">
                  Waiting for a machine. It appears here the moment it signs in.
                </p>
              }
            />
          </div>
          <div className="mt-6 flex items-center justify-between">
            <Button variant="ghost" onClick={onContinue}>
              Skip for now
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Waiting for a machine…</span>
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
  readonly onPaired: () => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPairing, setIsPairing] = useState(false);

  const submit = async () => {
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl });
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : "Pairing failed.");
  };

  return (
    <StepShell title="Pair with your server" onBack={onBack}>
      <div className="mt-5 space-y-4">
        <div>
          <p className="text-sm">
            <span className="font-semibold">1.</span>{" "}
            <span className="text-muted-foreground">On the server:</span>
          </p>
          <CommandBlock command="npx t3 pair" className="mt-2" />
          <p className="mt-1 text-xs text-muted-foreground">
            Prints a one-time pairing URL. Add{" "}
            <code className="rounded bg-muted px-1 font-mono">--tailscale</code> to publish on your
            tailnet.
          </p>
        </div>
        <div>
          <p className="text-sm">
            <span className="font-semibold">2.</span>{" "}
            <span className="text-muted-foreground">Paste the URL it prints:</span>
          </p>
          <Input
            className="mt-2"
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
      <div className="mt-6 flex justify-end">
        <Button
          disabled={isPairing || pairingUrl.trim().length === 0}
          onClick={() => void submit()}
        >
          {isPairing ? "Pairing…" : "Pair"}
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
 * Claude Code and Codex as hero cards with live probe status; the remaining
 * drivers listed quietly below. Install opens the built-in terminal inline
 * with the command pre-typed — the update RPC can't install a binary that
 * isn't there yet (it infers the package manager from the installed binary's
 * path), and the terminal also handles the interactive login that follows.
 */
function AgentsStep({
  onContinue,
  onSkip,
}: {
  readonly onContinue: () => void;
  readonly onSkip: () => void;
}) {
  const targetEnvironment = useOnboardingTargetEnvironment();
  if (targetEnvironment === null) {
    return (
      <StepShell title="Set up your agents" description="Waiting for an environment connection…">
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
      onContinue={onContinue}
      onSkip={onSkip}
    />
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
  onContinue,
  onSkip,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
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

  const byDriver = useMemo(() => {
    const map = new Map<string, ServerProvider>();
    for (const provider of providers ?? []) {
      if (!map.has(provider.driver)) map.set(provider.driver, provider);
    }
    return map;
  }, [providers]);

  const primaryAgents = PRIMARY_AGENT_DRIVERS.map((driver) => ({
    driver,
    provider: byDriver.get(driver),
  }));
  const readyCount = primaryAgents.filter(
    ({ provider }) =>
      provider?.enabled === true && provider.installed && provider.auth.status === "authenticated",
  ).length;
  const otherAgents = [...byDriver.keys()].filter(
    (driver) => !PRIMARY_AGENT_DRIVERS.includes(driver as (typeof PRIMARY_AGENT_DRIVERS)[number]),
  );

  return (
    <StepShell
      title="Set up your agents"
      description={`Checked on ${machineLabel}. You need at least one to start.`}
    >
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
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
      {otherAgents.length > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Also supported:{" "}
          {otherAgents
            .map((driver) => getDriverOption(driver as never)?.label ?? driver)
            .join(" · ")}{" "}
          — configure in Settings.
        </p>
      ) : null}
      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {readyCount} of {primaryAgents.length} ready
          </span>
          <Button onClick={onContinue}>Continue</Button>
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
  // A provider disabled in settings is neither ready nor installable from
  // here; the summary already reads "Disabled" and the card offers no action.
  const disabled = provider !== undefined && !provider.enabled;
  const usable = provider?.enabled === true && provider.installed;
  const ready = usable && provider.auth.status === "authenticated";
  const needsLogin = usable && provider.auth.status !== "authenticated";

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        ready ? "border-emerald-500/40" : terminalOpen ? "border-primary" : "border-border/70",
      )}
    >
      <div className="flex items-center gap-2.5">
        {Icon ? <Icon className="size-6" /> : null}
        <span className="text-sm font-semibold">{displayName}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {summary.headline}
        {summary.detail ? ` · ${summary.detail}` : ""}
      </p>
      <div className="mt-3">
        {ready ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-500">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : disabled ? (
          <span className="text-xs text-muted-foreground">Enable in Settings</span>
        ) : (
          <Button size="xs" variant="outline" onClick={onOpenTerminal} disabled={terminalOpen}>
            <TerminalIcon className="size-3.5" />
            {needsLogin ? "Sign in" : "Install"}
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
// Each drawer mount gets its own PTY: install and sign-in for the same
// driver must not share a session, or the second open would reattach and
// either duplicate the pre-typed command or feed it to a running process.
let onboardingTerminalSequence = 0;

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
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
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
  const [terminalId] = useState(() => {
    onboardingTerminalSequence += 1;
    return `onboarding-${driver}-${onboardingTerminalSequence}`;
  });
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
        if (cancelled || command.length === 0) return;
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
    <div className="mt-4 overflow-hidden rounded-lg border border-border/70">
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
function ImportStep({ onDone }: { readonly onDone: () => void }) {
  const targetEnvironment = useOnboardingTargetEnvironment();
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

  const candidates = useMemo(
    () => (scan.data?.candidates ?? []).filter((candidate) => !candidate.alreadyImported),
    [scan.data],
  );
  const recentCutoff = Date.now() - IMPORT_RECENT_WINDOW_MS;
  const recent = useMemo(
    () =>
      candidates.filter(
        (candidate) =>
          candidate.lastActiveAt !== null && Date.parse(candidate.lastActiveAt) >= recentCutoff,
      ),
    [candidates, recentCutoff],
  );
  const older = candidates.length - recent.length;

  const runImport = async (selection: ReadonlyArray<AgentSessionProjectCandidate>) => {
    if (environmentId === null || selection.length === 0) {
      onDone();
      return;
    }
    setIsImporting(true);
    setImportError("");
    const defaultModelSelection = resolveDefaultProviderModelSelection(providers ?? [], null);
    // Interrupted imports are neither failures nor successes — the command was
    // superseded or the environment dropped — but they still didn't land, so
    // they must not read as "imported everything".
    let imported = 0;
    let failed = 0;
    for (const candidate of selection) {
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
      if (result._tag === "Success") {
        imported += 1;
      } else if (!isAtomCommandInterrupted(result)) {
        failed += 1;
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
        title="Bring your work with you"
        description="Looking for existing Claude Code and Codex projects…"
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
        title="Bring your work with you"
        description={
          scan.error !== null
            ? "We couldn't scan for existing agent projects on this machine."
            : "No existing Claude Code or Codex projects found on this machine."
        }
      >
        <p className="mt-3 text-xs text-muted-foreground">
          You can add projects any time from the command palette.
        </p>
        <div className="mt-6 flex justify-end">
          <Button onClick={onDone}>Finish</Button>
        </div>
      </StepShell>
    );
  }

  if (choosing) {
    const selectedCount = candidates.length - deselected.size;
    return (
      <StepShell
        title="Choose projects to import"
        onBack={() => setChoosing(false)}
        description={`${candidates.length} projects found on ${machineLabel}.`}
      >
        <div className="mt-4 max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {candidates.map((candidate) => (
            <label
              key={candidate.path}
              className="flex cursor-pointer items-baseline gap-2.5 rounded-lg border border-border/60 px-3 py-2"
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
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{candidate.path}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {candidate.sources.map(formatSource).join(", ")} · {candidate.threadCount}{" "}
                {candidate.threadCount === 1 ? "thread" : "threads"}
                {candidate.lastActiveAt ? ` · ${formatRelativeTime(candidate.lastActiveAt)}` : ""}
              </span>
            </label>
          ))}
        </div>
        {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" disabled={isImporting} onClick={onDone}>
            Skip
          </Button>
          <Button
            disabled={isImporting || selectedCount === 0}
            onClick={() =>
              void runImport(candidates.filter((candidate) => !deselected.has(candidate.path)))
            }
          >
            {isImporting ? "Importing…" : `Import ${selectedCount}`}
          </Button>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      title="Bring your work with you"
      description={`Found ${recent.length} ${recent.length === 1 ? "project" : "projects"} active in the last 30 days on ${machineLabel}, from Claude Code and Codex.${older > 0 ? ` ${older} older ${older === 1 ? "project is" : "projects are"} available too.` : ""}`}
    >
      {importError ? <p className="mt-3 text-sm text-destructive">{importError}</p> : null}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button
          disabled={isImporting || recent.length === 0}
          onClick={() => void runImport(recent)}
        >
          {isImporting ? "Importing…" : `Import recent (${recent.length})`}
        </Button>
        <Button variant="outline" disabled={isImporting} onClick={() => setChoosing(true)}>
          Choose…
        </Button>
        <Button variant="ghost" disabled={isImporting} onClick={onDone}>
          Skip
        </Button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Imports projects only. Thread history import coming soon.
      </p>
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
        <button
          type="button"
          onClick={onBack}
          className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-3.5" />
          Back
        </button>
      ) : null}
      <h1
        className={cn(
          "text-2xl font-semibold tracking-tight sm:text-3xl",
          onBack ? "mt-2" : "mt-3",
        )}
      >
        {title}
      </h1>
      {description ? (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
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
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/60 font-mono",
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
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

function formatSource(source: "claudeAgent" | "codex"): string {
  return source === "claudeAgent" ? "Claude" : "Codex";
}

function formatRelativeTime(iso: string): string {
  const deltaMs = Date.now() - Date.parse(iso);
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
