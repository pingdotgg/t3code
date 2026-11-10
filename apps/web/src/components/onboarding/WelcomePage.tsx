import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionProjectCandidate,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName as agentName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AgentSessionSource,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  CommandId,
  AuthOrchestrationOperateScope,
  isManagedDriverAllowed,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useBlocker } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  SmartphoneIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { MOBILE_APP_URL } from "../../branding";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { useCloudLinkState } from "../../cloud/cloudLinkState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  groupOnboardingProjects,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  isNewOnboardingProject,
  resolveOnboardingProjectId,
  type OnboardingProjectGroup,
  splitOnboardingProjectPath,
} from "../../onboarding/projectImport.logic";
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";
import {
  cliTerminalStep,
  codexCardProvider,
  codexNeedsSetup,
  groupWelcomeAgents,
  isBrokenVersion,
  turnedOnInstance,
  welcomeAgentState,
  welcomeOffersPhone,
} from "../../onboarding/welcomePage.logic";
import {
  StoredWelcomeImportSelection,
  type WelcomeImportSelection,
  welcomeImportSelectionKey,
} from "../../onboarding/welcomeState";
import { newProjectId, randomUUID } from "../../lib/utils";
import { agentSessionImport } from "../../state/agentSessions";
import { readProjects, useProjects, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { managedTelemetryOffMessage, useManagedPolicy } from "../../state/managedPolicy";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { projectEnvironment } from "../../state/projects";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { getProviderSummary } from "../settings/providerStatus";
import { AddProviderInstanceDialog } from "../settings/AddProviderInstanceDialog";
import { useDesktopCliCommand } from "../settings/CliCommandSettingsRow";
import { CodexSetupSection } from "../settings/CodexSetupSection";
import { readCodexSetupMode } from "../settings/CodexSetupSection.logic";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ACPRegistryIcon } from "../Icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { QRCodeSvg } from "../ui/qr-code";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";

/**
 * First-run page for one computer: its agents, the projects found in agent history, and the
 * phone app. Every part is optional except one ready agent to start chatting.
 */
export function WelcomePage({
  environmentId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const { environments } = useEnvironments();
  const label =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "this computer";
  const agentReady = useWelcomeAgents(environmentId).readyCount > 0;
  // The phone and `t3` on PATH belong to the primary computer, so only it offers them.
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  // The same access Settings → Sharing & access checks.
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const showPhone = welcomeOffersPhone({
    isPrimary,
    cloud: hasCloudPublicConfig(),
    canShare: canReadRelay && canWriteRelay,
    policy: useManagedPolicy(environmentId),
  });
  const scans = useProjectScans([environmentId]);
  const [storedSelection, storeSelection] = useLocalStorage(
    welcomeImportSelectionKey(environmentId),
    null,
    StoredWelcomeImportSelection,
  );
  // The page keeps its own copy, so a failed write (a full quota) cannot undo a choice.
  const [importSelection, setImportSelectionState] = useState(storedSelection);
  const setImportSelection = (next: WelcomeImportSelection | null) => {
    setImportSelectionState(next);
    storeSelection(next);
  };
  const [isImporting, setIsImporting] = useState(false);
  // True from Start until the landing; leaving earlier would drop the import or the landing.
  const holdPageRef = useRef(false);
  useBlocker({
    shouldBlockFn: () => {
      if (!holdPageRef.current) return false;
      toastManager.add({
        id: "welcome-finishing",
        type: "info",
        title: "Finishing setup",
        description: "One moment.",
      });
      return true;
    },
    // Electron cancels a quit silently when unload is blocked. A later visit resumes the import.
    enableBeforeUnload: false,
  });
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  // Starting before the project list loads keeps saved picks, such as an import a quit cut short.
  const keepChoicesRef = useRef(false);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const finish = (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount = 0,
  ) => {
    if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }

    holdPageRef.current = true;
    const completion = completeOnboarding()
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        // Release before onDone so its own navigation is not blocked.
        holdPageRef.current = false;
        await onDone(projectRef);
        if (!keepChoicesRef.current) setImportSelection(null);
        if (importWarning) {
          toastManager.add({
            type: "warning",
            title: "Some history was not imported",
            description: importWarning,
            timeout: 0,
          });
        } else if (importedThreadCount > 0) {
          toastManager.add({
            type: "success",
            title: `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}`,
          });
        }
        return true;
      })
      .catch(() => {
        holdPageRef.current = false;
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
  };
  const projectImport = useProjectImport({
    scans,
    importSelection,
    onImportSelectionChange: setImportSelection,
    isImporting,
    setIsImporting,
    holdPageRef,
    onDone: finish,
  });
  // Without import permission, starting simply skips the projects.
  const selected = projectImport.canWrite ? projectImport.selected : [];
  const newCount = selected.filter(projectImport.isNew).length;
  const start = () => {
    keepChoicesRef.current = scans.some((scan) => scan.data === null);
    if (selected.length === 0) {
      projectImport.finishAfterImport();
      return;
    }
    // Stored now, so after a restart mid-import these stay checked even once they exist.
    projectImport.setSelectedKeys(new Set(selected.map((candidate) => candidate.key)));
    void projectImport.runImport(selected);
  };

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Welcome")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-12 pb-8 sm:pt-20">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Welcome to T3 Code
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Setting up <span className="text-foreground">{label}</span>.
            </p>
            <div className="mt-10 border-t border-border/60">
              <AgentsSection
                environmentId={environmentId}
                label={label}
                isPrimary={isPrimary}
                onImportSourceEnabled={() => scans[0]?.refresh()}
              />
              <ProjectsSection
                scan={scans[0]}
                projectImport={projectImport}
                isImporting={isImporting}
              />
              {showPhone ? <PhoneSection environmentId={environmentId} /> : null}
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              {agentReady ? (
                <span />
              ) : (
                <Button variant="ghost-muted" disabled={isImporting} onClick={start}>
                  Start without an agent
                </Button>
              )}
              <div className="flex items-center gap-3">
                {agentReady ? null : (
                  <span className="text-xs text-muted-foreground">Set up one agent to start.</span>
                )}
                <Button disabled={!agentReady || isImporting} onClick={start}>
                  {isImporting
                    ? selected.length > 0
                      ? "Importing…"
                      : "Starting…"
                    : newCount > 0
                      ? `Import ${newCount} ${newCount === 1 ? "project" : "projects"} and start`
                      : selected.length > 0
                        ? "Import threads and start"
                        : "Start"}
                </Button>
              </div>
            </div>
            <TelemetryNotice environmentId={environmentId} />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function TelemetryNotice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const telemetryOff = managedTelemetryOffMessage(useManagedPolicy(environmentId));
  return (
    <p className="mt-auto pt-12 text-2xs leading-relaxed text-muted-foreground/70">
      {telemetryOff ?? "T3 Code collects anonymous usage data to improve the app."}{" "}
      {telemetryOff === undefined ? "To opt out, see the" : "See the"}{" "}
      <a
        className="underline decoration-current/40 underline-offset-2 hover:text-muted-foreground"
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        privacy policy
      </a>
      .
    </p>
  );
}

// Each part of the page is one band: its label on the left, its rows on the right.
function WelcomeSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 border-b border-border/60 py-4 sm:grid-cols-[6rem_minmax(0,1fr)]">
      <h2 className="text-sm leading-10 text-muted-foreground">{title}</h2>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

// Rows share one icon column, so names, checkboxes, and steps line up down the page.
function RowIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {children}
    </span>
  );
}

const INSTALLABLE_DRIVERS = ["codex", "claudeAgent"] as const;
type OnboardingAgentDriver = (typeof INSTALLABLE_DRIVERS)[number];
const isInstallableDriver = (driver: string): driver is OnboardingAgentDriver =>
  (INSTALLABLE_DRIVERS as ReadonlyArray<string>).includes(driver);

interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

// Shared by the page (to enable Start) and the agents section, so both agree on what is ready.
function useWelcomeAgents(environmentId: EnvironmentId) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const managedPolicy = serverConfig?.managedPolicy;
  return {
    providers,
    serverConfig,
    ...groupWelcomeAgents(providers, serverConfig?.settings, agentName, (provider) =>
      isManagedDriverAllowed(managedPolicy, provider.driver),
    ),
  };
}

const isImportSource = Schema.is(AgentSessionSource);

// The setup card opens below a long list, so bring it into view once.
const revealOnMount = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

function AgentsSection({
  environmentId,
  label,
  isPrimary,
  onImportSourceEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  // The project scan only reads agents that are on, so turning one on can find more history.
  readonly onImportSourceEnabled: () => void;
}) {
  const { providers, serverConfig, checking, found, available } = useWelcomeAgents(environmentId);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [codexSetupId, setCodexSetupId] = useState<ProviderInstanceId | null>(null);
  const [cliTerminalFor, setCliTerminalFor] = useState<ProviderInstanceId | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment to refresh its provider list when the environment changes
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  // Opened once the finished checks find nothing, since adding an agent is then the task. A first
  // status can be wrong, so this waits for the checks, and a later check never closes it.
  if (moreOpen === null && !checking && found.length === 0) setMoreOpen(true);
  const showMore = moreOpen ?? false;
  const acpAllowed = isManagedDriverAllowed(serverConfig?.managedPolicy, ACP_REGISTRY_DRIVER_KIND);
  const stateOf = (provider: ServerProvider) => welcomeAgentState(provider, serverConfig?.settings);
  const needsInstallOrSignIn = (provider: ServerProvider) => {
    const state = stateOf(provider);
    return (
      isInstallableDriver(provider.driver) &&
      !isBrokenVersion(provider) &&
      (state === "install" || state === "signIn")
    );
  };
  // Codex's card also offers ChatGPT sign-in, which still works when the CLI check failed.
  // Codex setup stays mounted by instance while its status changes, so a sign-in that starts
  // after an install is not lost when the agent moves between groups or briefly leaves the list.
  const [lastCodex, setLastCodex] = useState<ServerProvider | null>(null);
  const listedCodex =
    codexSetupId === null
      ? undefined
      : providers?.find((provider) => provider.instanceId === codexSetupId);
  if (listedCodex !== undefined && listedCodex !== lastCodex) setLastCodex(listedCodex);
  const codexSetupProvider = codexCardProvider({
    providers,
    instanceId: codexSetupId,
    last: lastCodex,
    settings: serverConfig?.settings,
  });
  // Once the card closes, a later status change does not reopen it and move the page.
  if (listedCodex !== undefined && codexSetupProvider === null) setCodexSetupId(null);

  const openTerminal = (provider: ServerProvider) => {
    if (
      !isInstallableDriver(provider.driver) ||
      serverConfig === null ||
      !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
    )
      return;
    setTerminalSession({
      environmentId,
      driver: provider.driver,
      providerInstanceId: provider.instanceId,
      cwd: serverConfig.cwd,
      command: provider.installed
        ? resolveOnboardingProviderLoginCommand(
            provider,
            serverConfig.settings,
            serverConfig.environment.platform.os,
          )
        : resolveOnboardingProviderInstallCommand(
            provider.driver,
            serverConfig.environment.platform.os,
          ),
      keybindings: serverConfig.keybindings,
    });
  };

  // "Use existing CLI" opens the CLI's terminal once Codex has checked the CLI.
  const cliProvider =
    cliTerminalFor === null
      ? undefined
      : providers?.find((provider) => provider.instanceId === cliTerminalFor);
  const cliStep =
    cliProvider === undefined ? "done" : cliTerminalStep(cliProvider, serverConfig?.settings);
  if (cliProvider !== undefined && cliStep !== "wait") {
    setCliTerminalFor(null);
    if (cliStep === "open") openTerminal(cliProvider);
  }

  const turnOn = async (provider: ServerProvider) => {
    if (serverConfig === null) return;
    const instance = serverConfig.settings.providerInstances[provider.instanceId] ?? {
      driver: provider.driver,
    };
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId: provider.instanceId,
      instance: turnedOnInstance(instance),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not turn on ${agentName(provider)}`,
          ...(cause instanceof Error ? { description: cause.message } : {}),
        });
      }
      return;
    }
    void refreshProviders({ environmentId, input: { instanceId: provider.instanceId } });
    if (isImportSource(provider.driver)) onImportSourceEnabled();
  };

  // One action per agent, the same in the list and in the grid.
  const actionFor = (provider: ServerProvider) => {
    const state = stateOf(provider);
    const name = agentName(provider);
    const settingsAction = (actionLabel: string) => (
      <Button
        size="xs"
        variant="outline"
        aria-label={`${actionLabel}: ${name}`}
        render={
          <Link
            to="/settings/providers"
            search={{ environmentId, instanceId: provider.instanceId }}
          />
        }
      >
        {actionLabel}
      </Button>
    );
    if (state === "disabled") {
      return (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Turn on: ${name}`}
          disabled={!canManageProviders || serverConfig === null}
          onClick={() => void turnOn(provider)}
        >
          Turn on
        </Button>
      );
    }
    // Settings updates a broken CLI the way it was installed, including a custom binary path.
    if (isBrokenVersion(provider)) return settingsAction("Update");
    if (serverConfig !== null && codexNeedsSetup(provider, serverConfig.settings)) {
      const open = codexSetupId === provider.instanceId;
      return (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Set up: ${name}`}
          aria-expanded={open}
          onClick={() => setCodexSetupId(open ? null : provider.instanceId)}
        >
          Set up
        </Button>
      );
    }
    if (needsInstallOrSignIn(provider)) {
      return (
        <TerminalAction
          name={name}
          signIn={state === "signIn"}
          disabled={
            terminalSession?.providerInstanceId === provider.instanceId ||
            serverConfig === null ||
            !canOperateTerminal
          }
          onClick={() => openTerminal(provider)}
        />
      );
    }
    return settingsAction(
      state === "signIn" ? "Sign in" : state === "attention" ? "Details" : "Set up",
    );
  };

  const notes = [
    !canOperateTerminal &&
    [...found, ...available].some(
      (provider) =>
        needsInstallOrSignIn(provider) || codexNeedsSetup(provider, serverConfig?.settings),
    )
      ? "This connection cannot control terminals."
      : null,
    !canManageProviders &&
    (acpAllowed ||
      [...found, ...available].some(
        (provider) =>
          stateOf(provider) === "disabled" || codexNeedsSetup(provider, serverConfig?.settings),
      ))
      ? "This connection cannot manage agents."
      : null,
  ].filter((note) => note !== null);

  return (
    <WelcomeSection title="Agents">
      {found.map((provider) => (
        <AgentRow
          key={provider.instanceId}
          provider={provider}
          state={stateOf(provider)}
          action={actionFor(provider)}
        />
      ))}
      {checking && found.length === 0 ? (
        <p className="text-sm leading-10 text-muted-foreground">Checking {label}…</p>
      ) : null}
      {notes.map((note) => (
        <p key={note} className="pl-8 text-xs text-muted-foreground">
          {note}
        </p>
      ))}
      <Collapsible open={showMore} onOpenChange={setMoreOpen}>
        <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <RowIcon>
            <PlusIcon className="size-4" />
          </RowIcon>
          <span
            className={cn(
              "text-sm group-hover:text-foreground",
              found.length > 0 ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {found.length > 0 ? "Add more agents" : "Set up an agent"}
          </span>
          {showMore ? null : <AgentLogoStack providers={available} acp={acpAllowed} />}
          <ChevronDownIcon className="ml-auto size-4 text-muted-foreground group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            {available.map((provider) => (
              <AgentRow
                key={provider.instanceId}
                provider={provider}
                state={stateOf(provider)}
                compact
                action={actionFor(provider)}
              />
            ))}
          </div>
          {acpAllowed ? (
            <div className="flex min-h-9 items-center gap-3">
              <RowIcon>
                <ACPRegistryIcon className="size-4" />
              </RowIcon>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                More agents in the ACP Registry
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={!canManageProviders}
                onClick={() => setAddingProvider(true)}
              >
                Browse
              </Button>
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
      {codexSetupProvider !== null && serverConfig !== null ? (
        <div key={codexSetupProvider.instanceId} ref={revealOnMount} className="mt-2">
          <OnboardingCodexSetup
            environmentId={environmentId}
            provider={codexSetupProvider}
            serverConfig={serverConfig}
            onUseCliChange={(useCli) =>
              setCliTerminalFor(useCli ? codexSetupProvider.instanceId : null)
            }
          />
        </div>
      ) : null}
      {isPrimary ? <CliPathSetup /> : null}
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
      {addingProvider ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={label}
          showMoreProviders
          onOpenChange={setAddingProvider}
          onCreated={(_instanceId, driver) => {
            void refreshProviders({ environmentId, input: {} });
            // A new Claude Code, Codex, or Pi instance can bring more history to import.
            if (isImportSource(driver)) onImportSourceEnabled();
          }}
        />
      ) : null}
    </WelcomeSection>
  );
}

// A quiet preview of what the fold holds; the names are inside it.
function AgentLogoStack({
  providers,
  acp,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly acp: boolean;
}) {
  if (providers.length === 0 && !acp) return null;
  return (
    <span className="flex items-center gap-2 opacity-60 grayscale" aria-hidden>
      {providers.slice(0, 6).map((provider) => (
        <ProviderInstanceIcon
          key={provider.instanceId}
          driverKind={provider.driver}
          displayName={agentName(provider)}
          iconClassName="size-3.5"
        />
      ))}
      {acp ? <ACPRegistryIcon className="size-3.5" /> : null}
    </span>
  );
}

function ProjectsSection({
  scan,
  projectImport,
  isImporting,
}: {
  readonly scan: ReturnType<typeof useProjectScans>[number] | undefined;
  readonly projectImport: ReturnType<typeof useProjectImport>;
  readonly isImporting: boolean;
}) {
  const [reviewing, setReviewing] = useState(false);
  const {
    canWrite,
    candidates,
    isNew,
    recent,
    selected,
    selectedKeys,
    setSelectedKeys,
    visibleImportError,
  } = projectImport;
  if (scan === undefined) return null;
  if (scan.isPending && candidates.length === 0) {
    return (
      <WelcomeSection title="Projects">
        <p className="text-sm leading-10 text-muted-foreground">
          Looking for projects in your {IMPORT_SOURCES_LABEL} history…
        </p>
      </WelcomeSection>
    );
  }
  const retry = (
    <Button variant="ghost" size="sm" onClick={scan.refresh}>
      Retry
    </Button>
  );
  if (scan.error !== null && candidates.length === 0) {
    return (
      <WelcomeSection title="Projects">
        <div
          role="alert"
          className="flex min-h-10 items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <span>Could not check projects. {scan.error}</span>
          {retry}
        </div>
      </WelcomeSection>
    );
  }
  if (candidates.length === 0) {
    return scan.data?.truncated ? (
      <WelcomeSection title="Projects">
        <p className="text-xs leading-10 text-muted-foreground" role="status">
          {SCAN_LIMIT_MESSAGE}
        </p>
      </WelcomeSection>
    ) : null;
  }

  const allKeys = candidates.map((candidate) => candidate.key);
  // Checking the box picks recent new projects, else any new ones, else everything listed.
  const fresh = candidates.filter(isNew);
  const defaultKeys = (recent.length > 0 ? recent : fresh.length > 0 ? fresh : candidates).map(
    (candidate) => candidate.key,
  );
  const partial =
    selected.length > 0 &&
    selected.length < candidates.length &&
    !(selected.length === defaultKeys.length && defaultKeys.every((key) => selectedKeys.has(key)));
  return (
    <WelcomeSection title="Projects">
      <div className="flex min-h-10 items-center gap-3 py-1">
        <label className="flex min-w-0 flex-1 items-center gap-3">
          <RowIcon>
            <Checkbox
              checked={canWrite && selected.length > 0}
              indeterminate={canWrite && partial}
              disabled={isImporting || !canWrite}
              onCheckedChange={(checked) =>
                setSelectedKeys(new Set(checked ? defaultKeys : []), { optedOut: !checked })
              }
            />
          </RowIcon>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              {canWrite && selected.length > 0
                ? `Import ${selected.length} ${selected.length === 1 ? "project" : "projects"} and their threads`
                : "Import projects and their threads"}
            </span>
            <span className="block text-xs text-muted-foreground">
              From your {IMPORT_SOURCES_LABEL} history
            </span>
          </span>
        </label>
        {canWrite ? (
          <Button
            variant="ghost-muted"
            size="xs"
            aria-expanded={reviewing}
            onClick={() => setReviewing((open) => !open)}
          >
            {reviewing ? "Hide" : `Review all ${candidates.length}`}
            <ChevronDownIcon className={cn("size-3.5", reviewing && "rotate-180")} />
          </Button>
        ) : null}
      </div>
      {reviewing && canWrite ? (
        // The negative margin lines the list's checkboxes up with the one above it.
        <fieldset className="-mx-1.5 mt-1 min-w-0" disabled={isImporting}>
          <div className="flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
            <span role="status">
              {selected.length} of {candidates.length} selected
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={selected.length === candidates.length}
                onClick={() => setSelectedKeys(new Set(allKeys))}
              >
                Select all
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={selected.length === 0}
                onClick={() => setSelectedKeys(new Set())}
              >
                Select none
              </Button>
            </div>
          </div>
          <ScrollArea scrollFade className="mt-1 h-auto max-h-80">
            <div className="space-y-0.5 pr-3">
              <ImportCandidateList
                candidates={candidates}
                selectedKeys={selectedKeys}
                onSelectionChange={setSelectedKeys}
              />
            </div>
          </ScrollArea>
        </fieldset>
      ) : null}
      {scan.data?.truncated ? (
        <p className="pl-8 text-xs text-muted-foreground" role="status">
          {SCAN_LIMIT_MESSAGE}
        </p>
      ) : null}
      {scan.error !== null ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 pl-8 text-sm text-muted-foreground"
        >
          <span>Could not check projects again. {scan.error}</span>
          {retry}
        </div>
      ) : null}
      {visibleImportError ? (
        <p className="pt-1 pl-8 text-sm text-destructive">{visibleImportError}</p>
      ) : null}
    </WelcomeSection>
  );
}

function PhoneSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  return (
    <WelcomeSection title="Phone">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-h-10 items-center gap-3 py-1">
          <RowIcon>
            <SmartphoneIcon className="size-4" />
          </RowIcon>
          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
            Use T3 Code on your phone
          </span>
          <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
            {open ? "Hide" : "Set up"}
            <ChevronDownIcon className={cn("size-3.5", open && "rotate-180")} />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div className="flex items-center gap-8 pt-2 pb-3 pl-8">
            <ol className="min-w-0 flex-1 space-y-5">
              <PhoneStep step={1}>
                <p className="text-sm text-foreground">Scan with your phone to get the app.</p>
              </PhoneStep>
              <PhoneStep step={2}>
                <PhoneConnectLink environmentId={environmentId} />
              </PhoneStep>
            </ol>
            {/* One code for both stores: the link opens the store that matches the phone. */}
            <div className="shrink-0 rounded-lg bg-white p-1.5">
              <QRCodeSvg
                value={MOBILE_APP_URL}
                size={124}
                level="M"
                marginSize={2}
                title="T3 Code app for iPhone and Android"
              />
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </WelcomeSection>
  );
}

function PhoneStep({ step, children }: { readonly step: number; readonly children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="w-3 shrink-0 text-sm text-muted-foreground tabular-nums">{step}</span>
      <div className="flex min-w-0 flex-col items-start gap-2">{children}</div>
    </li>
  );
}

function PhoneConnectLink({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const linkState = useCloudLinkState(environmentId);
  const refreshLinkState = useEffectEvent(linkState.refresh);
  // The server rechecks the tunnel every 30 s; read its latest result while this panel is open.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 30 s interval that refreshes the cloud link reachability while mounted
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const link = linkState.data;
  // The phone reaches this computer through its tunnel; older servers leave that flag out.
  const shared =
    link !== null &&
    link.linked &&
    link.linkRevoked !== true &&
    link.cloudUserId === userId &&
    link.managedTunnelActive !== false;
  // The server checks the tunnel on its own; until it has, the result is unknown.
  const reachability = shared ? link.reachability?.status : undefined;
  const settingsLink = (label: string) => (
    <Button variant="outline" size="xs" render={<Link to="/settings/access" />}>
      {label}
    </Button>
  );
  if (isSignedIn && link === null && linkState.isPending) {
    return <p className="text-sm text-muted-foreground">Checking T3 Connect…</p>;
  }
  if (isSignedIn && linkState.error !== null) {
    return (
      <>
        <p className="text-sm text-foreground">Could not check T3 Connect.</p>
        {settingsLink("Check T3 Connect")}
      </>
    );
  }
  if (isSignedIn && reachability === "reachable") {
    return (
      <p className="flex gap-1.5 text-sm text-foreground">
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-success-foreground" />
        Your phone can reach this computer. Sign in to the app with the same account.
      </p>
    );
  }
  if (isSignedIn && shared && reachability === undefined) {
    return (
      <p className="text-sm text-foreground">
        T3 Connect is on for this computer. Sign in to the app with the same account.
      </p>
    );
  }
  if (isSignedIn) {
    // Signing in alone does not share this computer, for example after "Not now".
    return (
      <>
        <p className="text-sm text-foreground">
          {shared
            ? "T3 Connect is on, but the app cannot reach this computer."
            : "Signed in. Share this computer so the app can reach it."}
        </p>
        {settingsLink(shared ? "Check T3 Connect" : "Set up T3 Connect")}
      </>
    );
  }
  return (
    <>
      <p className="text-sm text-foreground">
        Sign in to T3 Connect here, then in the app with the same account.
      </p>
      <Button variant="outline" size="xs" disabled={!isLoaded} onClick={openAuthPrompt}>
        Sign in to T3 Connect
      </Button>
    </>
  );
}

// The ChatGPT card and the CLI card stay one card, so either choice can be undone here.
function OnboardingCodexSetup({
  environmentId,
  provider,
  serverConfig,
  onUseCliChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly serverConfig: ServerConfig;
  // True asks for the CLI's install or sign-in terminal once Codex has checked the CLI.
  readonly onUseCliChange: (useCli: boolean) => void;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const instanceId = provider.instanceId;
  const instance = serverConfig.settings.providerInstances[instanceId] ?? {
    driver: provider.driver,
    config: {},
  };
  const config =
    instance.config !== null && typeof instance.config === "object" ? instance.config : {};
  const mode = readCodexSetupMode(config);
  // The server only signs in to its own runtime, so ChatGPT sign-in saves "managed" first.
  // An attempt that ends without signing in puts back what was saved before it.
  const modeBeforeSignIn = useRef<{ readonly setupMode: unknown } | null>(null);
  const changeMode = (setupMode: "managed" | "existing") => {
    // "Use existing CLI" also opens a terminal to install or sign in to the CLI.
    onUseCliChange(setupMode === "existing");
    const unchanged = mode === setupMode && provider.enabled;
    if (unchanged || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    modeBeforeSignIn.current =
      setupMode === "managed" && mode !== "managed"
        ? { setupMode: "setupMode" in config ? config.setupMode : undefined }
        : null;
    // One-instance upsert keeps a provider another client added in the meantime.
    void persistProviderInstance({
      operation: "upsert",
      instanceId,
      instance: { ...instance, enabled: true, config: { ...config, enabled: true, setupMode } },
    }).then((result) => {
      if (result._tag === "Failure") {
        modeBeforeSignIn.current = null;
        onUseCliChange(false);
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not save Codex setup",
            ...(cause instanceof Error ? { description: cause.message } : {}),
          });
        }
      }
    });
  };
  const restoreMode = () => {
    const before = modeBeforeSignIn.current;
    if (before === null) return;
    modeBeforeSignIn.current = null;
    // Sign-in ends after later renders, so restore onto the settings as they are now.
    const current =
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.settings
        .providerInstances[instanceId] ?? instance;
    const { setupMode: _managed, ...rest } =
      current.config !== null && typeof current.config === "object" ? current.config : {};
    void persistProviderInstance({
      operation: "upsert",
      instanceId,
      instance: {
        ...current,
        config: before.setupMode === undefined ? rest : { ...rest, setupMode: before.setupMode },
      },
    });
  };
  return (
    <CodexSetupSection
      presentation="onboarding"
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      mode={mode}
      enabled={provider.enabled}
      readOnly={!canManageProviders}
      existingCliDisabled={!canOperateTerminal}
      displayName={agentName(provider)}
      onModeChange={changeMode}
      onSignInUnfinished={restoreMode}
      onSignInFinished={() => {
        modeBeforeSignIn.current = null;
      }}
    />
  );
}

function TerminalAction({
  name,
  signIn,
  disabled,
  onClick,
}: {
  readonly name: string;
  readonly signIn: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const label = signIn ? "Sign in" : "Install";
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={`${label}: ${name}`}
      disabled={disabled}
      onClick={onClick}
    >
      <TerminalIcon className="size-3.5" />
      {label}
    </Button>
  );
}

function AgentRow({
  provider,
  state,
  action,
  compact = false,
}: {
  readonly provider: ServerProvider;
  readonly state: ReturnType<typeof welcomeAgentState>;
  readonly action?: ReactNode;
  // A row in the "Add more agents" grid: the button carries the state, so no detail line.
  readonly compact?: boolean;
}) {
  const name = agentName(provider);
  // Claude Code and Codex tiles show Install or Set up; other agents that are on say why not.
  const brokenMessage = isBrokenVersion(provider)
    ? (provider.compatibilityAdvisory?.message ?? null)
    : null;
  const detail =
    state === "install"
      ? isInstallableDriver(provider.driver)
        ? null
        : "Not installed"
      : compact || state === "ready" || state === "checking"
        ? null
        : state === "attention"
          ? (provider.unavailableReason ??
            brokenMessage ??
            provider.message ??
            getProviderSummary(provider).headline)
          : (brokenMessage ?? getProviderSummary(provider).headline);
  return (
    <div className={cn("flex items-center gap-3", compact ? "min-h-9" : "min-h-10 py-1")}>
      <RowIcon>
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={name}
          iconClassName={compact ? "size-4" : "size-[18px]"}
        />
      </RowIcon>
      <div className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm text-foreground", !compact && "font-medium")}>
          {name}
        </span>
        {detail ? (
          <p className="line-clamp-2 text-xs leading-relaxed break-words text-muted-foreground">
            {detail}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        {state === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : state === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking…</span>
        ) : (
          action
        )}
      </div>
    </div>
  );
}

function AgentInstallTerminal({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
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
  const threadRef = scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // StrictMode can finish a cancelled open after replacement setup; it must not close or pre-type into that
  // session.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the setup PTY, types the command into it, and closes it on cleanup
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    // oxlint-disable-next-line react/set-state-in-effect -- A retry or a new command reopens the terminal, which shows as preparing until the open settles.
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
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
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Revocation leaves the PTY running; close only while terminal access remains.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps setupAttempt to open the terminal again.
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal ? (
            "This connection cannot control terminals."
          ) : setupState === "writeFailed" ? (
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
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
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
            autoFocus
            visible
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

const IMPORT_PERMISSION_MESSAGE = "This connection cannot import projects or thread history.";

// Creates the selected projects, then imports each one's agent history. Owns retry state so a
// second Start resumes instead of recreating projects.
function useProjectImport({
  scans,
  importSelection,
  onImportSelectionChange,
  isImporting,
  setIsImporting,
  holdPageRef,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly importSelection: WelcomeImportSelection | null;
  readonly onImportSelectionChange: (next: WelcomeImportSelection) => void;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  // Blocks leaving the page; onDone releases it before landing.
  readonly holdPageRef: { current: boolean };
  readonly onDone: (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount?: number,
  ) => Promise<boolean>;
}) {
  const writableEnvironments = useEnvironmentsWithScope(scans, AuthOrchestrationOperateScope);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const importWarningRef = useRef("");
  // Per project, so a retry that skips finished projects still counts their threads.
  const importedThreadsRef = useRef(new Map<string, number>());
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bumps the import generation on mount and unmount so in-flight imports drop stale results
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  const { available: candidates, recent: recentActive } = partitionOnboardingProjects(
    scans.flatMap((scan) =>
      (scan.data?.candidates ?? []).map((candidate) => ({
        ...candidate,
        environmentId: scan.environmentId,
        key: onboardingProjectKey(scan.environmentId, candidate.path),
      })),
    ),
  );
  // Projects already in T3 Code stay in the list, but reopening the page does not import their
  // history again unless the user picks them. The scan can be 30 s old, so the live list decides.
  const projects = useProjects();
  const isNewProject = isNewOnboardingProject(projects);
  const isNew = (candidate: ImportCandidate) => isNewProject(candidate.environmentId, candidate);
  const recent = recentActive.filter(isNew);
  const recentKeys = new Set(recent.map((candidate) => candidate.key));
  const knownKeys = new Set(importSelection?.knownKeys);
  const pickedKeys = new Set(importSelection?.keys);
  const selected = importSelection?.optedOut
    ? []
    : candidates.filter((candidate) =>
        knownKeys.has(candidate.key)
          ? pickedKeys.has(candidate.key)
          : recentKeys.has(candidate.key),
      );
  const selectedKeys = new Set(selected.map((candidate) => candidate.key));
  const setSelectedKeys = (keys: ReadonlySet<string>, { optedOut = false } = {}) =>
    onImportSelectionChange({
      knownKeys: candidates.map((candidate) => candidate.key),
      keys: [...keys],
      optedOut,
    });

  const canWrite = scans.every((scan) => writableEnvironments.has(scan.environmentId));
  const canImport = selected.every((candidate) =>
    writableEnvironments.has(candidate.environmentId),
  );
  const visibleImportError = canWrite && canImport ? "" : IMPORT_PERMISSION_MESSAGE;

  const importedThreadTotal = () =>
    lastImportSelectionRef.current.reduce(
      (total, key) => total + (importedThreadsRef.current.get(key) ?? 0),
      0,
    );

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    // Busy until setup is saved, so Start cannot run the import again meanwhile.
    setIsImporting(true);
    if (projectRef === undefined) {
      void onDone(undefined, importWarningRef.current, importedThreadTotal()).then((completed) => {
        if (!completed) setIsImporting(false);
      });
      return;
    }
    holdPageRef.current = true;
    const importGeneration = importGenerationRef.current;
    // waitForProject gives up after its timeout, so a project that never reaches the client
    // still finishes setup, just without landing in it.
    void waitForProject(projectRef)
      .then(
        () => projectRef,
        () => undefined,
      )
      .then(async (landing) => {
        if (importGeneration !== importGenerationRef.current) {
          holdPageRef.current = false;
          return;
        }
        const completed = await onDone(landing, importWarningRef.current, importedThreadTotal());
        if (!completed) setIsImporting(false);
      });
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    const hasAccess = () =>
      selection.every((candidate) =>
        readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope),
      );
    // The permission message shows from the session's scopes.
    const stopForDeniedAccess = () => setIsImporting(false);
    if (!hasAccess()) {
      stopForDeniedAccess();
      return;
    }
    setIsImporting(true);
    importWarningRef.current = "";
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedThreads = importedThreadsRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.key)).length
        : 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    // Resolves false when the run stopped early: a newer run, an unmount, or lost access.
    const importEach = async () => {
      for (const candidate of selection) {
        const { environmentId } = candidate;
        if (importGeneration !== importGenerationRef.current) return false;
        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
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
          if (importGeneration !== importGenerationRef.current) return false;
          if (result._tag !== "Success") {
            if (!isAtomCommandInterrupted(result)) {
              projectAttempts.delete(candidate.key);
              refreshEnvironments.add(environmentId);
            }
            continue;
          }
        }

        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
        }
        const threadImportResult = await importThreads({
          environmentId,
          input: { projectId, expectedWorkspaceRoot: candidate.path },
        });
        if (importGeneration !== importGenerationRef.current) return false;
        if (threadImportResult._tag === "Success") {
          importedThreads.set(
            candidate.key,
            (importedThreads.get(candidate.key) ?? 0) + threadImportResult.value.importedCount,
          );
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
      return true;
    };
    holdPageRef.current = true;
    const completed = await importEach().finally(() => {
      holdPageRef.current = false;
    });
    if (!completed) return;
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setIsImporting(false);
    const importedThreadCount = importedThreadTotal();
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        importWarningRef.current = `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. ${skippedThreadCount} ${skippedThreadCount === 1 ? "thread" : "threads"} could not be imported.`;
      } else if (skippedThreadCount > 0) {
        importWarningRef.current = `${skippedThreadCount} ${skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`;
      } else if (importedThreadCount > 0) {
        importWarningRef.current = `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. Some thread history could not be imported.`;
      } else {
        importWarningRef.current = "Could not import thread history.";
      }
    }
    finishAfterImport();
  };

  return {
    canWrite,
    candidates,
    isNew,
    recent,
    selected,
    selectedKeys,
    setSelectedKeys,
    visibleImportError,
    runImport,
    finishAfterImport,
  };
}

type ImportCandidate = AgentSessionProjectCandidate & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
};

function ImportCandidateList({
  candidates,
  selectedKeys,
  onSelectionChange,
}: {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectionChange: (next: ReadonlySet<string>) => void;
}) {
  const { repositories, other } = groupOnboardingProjects(candidates);
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
                path={candidate.path}
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
        path={only.path}
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
            path={candidate.path}
            nested
            checked={selectedKeys.has(candidate.key)}
            onCheckedChange={(checked) => onToggle([candidate.key], checked)}
          />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ProjectPathText({
  path,
  className,
}: {
  readonly path: string;
  readonly className?: string;
}) {
  const { name, parent } = splitOnboardingProjectPath(path);
  return (
    <span className={cn("flex min-w-0 items-baseline font-mono", className)}>
      {parent.length > 0 ? <span className="truncate">{parent}</span> : null}
      <span className="max-w-full shrink-0 truncate">{name}</span>
    </span>
  );
}

function ImportCandidateRow({
  candidate,
  label,
  path,
  nested = false,
  checked,
  onCheckedChange,
}: {
  readonly candidate: ImportCandidate;
  readonly label?: string;
  readonly path?: string;
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
          {label !== undefined ? (
            <span className="truncate text-sm font-medium">{label}</span>
          ) : null}
          {path !== undefined ? (
            <ProjectPathText
              path={path}
              className={label === undefined ? "text-xs" : "text-2xs text-muted-foreground"}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup variant="code">{candidate.path}</TooltipPopup>
      </Tooltip>
      <ImportRowMeta
        sources={nested ? null : candidate.sources}
        threadCount={candidate.threadCount}
        lastActiveAt={candidate.lastActiveAt}
      />
    </label>
  );
}

const IMPORT_SOURCE_NAMES: Record<AgentSessionSource, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};
const IMPORT_SOURCES_LABEL = new Intl.ListFormat("en", { type: "conjunction" }).format(
  AgentSessionSource.literals.map((source) => IMPORT_SOURCE_NAMES[source]),
);

function ImportRowMeta({
  sources,
  threadCount,
  lastActiveAt,
}: {
  readonly sources: ReadonlyArray<AgentSessionSource> | null;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}) {
  const relative = lastActiveAt === null ? null : formatRelativeTime(lastActiveAt);
  const age = relative === null ? "" : relative.suffix === null ? "now" : relative.value;
  return (
    <span className="ml-auto grid shrink-0 grid-cols-[1rem_1rem_1rem_2.5rem_2.25rem] items-center gap-x-1 text-xs text-muted-foreground tabular-nums">
      {AgentSessionSource.literals.map((source) => (
        <span key={source} className="flex size-4 items-center justify-center">
          {sources?.includes(source) ? (
            <span role="img" aria-label={IMPORT_SOURCE_NAMES[source]}>
              <ProviderInstanceIcon
                driverKind={ProviderDriverKind.make(source)}
                displayName={IMPORT_SOURCE_NAMES[source]}
                iconClassName="size-3"
              />
            </span>
          ) : null}
        </span>
      ))}
      <span className="text-right">{threadCount}</span>
      <span className="text-right whitespace-nowrap">{age}</span>
    </span>
  );
}

/** The desktop app links `t3` on a fresh install; this puts its folder on PATH when it is not. */
function CliPathSetup() {
  const { state, busy, run } = useDesktopCliCommand();
  const setup = state?.pathSetup;
  if (!setup) return null;
  return (
    <div className="flex min-h-10 items-center gap-3">
      <RowIcon>
        <TerminalIcon className="size-4" />
      </RowIcon>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {setup.added ? (
          <>
            Added to {setup.file}. Open a new terminal to use <code className="font-mono">t3</code>.
          </>
        ) : (
          <>
            Use <code className="font-mono">t3</code> from any terminal. Adds one line to{" "}
            {setup.file}.
          </>
        )}
      </p>
      {setup.added ? null : (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
          Add to PATH
        </Button>
      )}
    </div>
  );
}
