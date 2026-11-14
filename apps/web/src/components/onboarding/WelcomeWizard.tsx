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
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AgentSessionSource,
  AuthTerminalOperateScope,
  CommandId,
  defaultInstanceIdForDriver,
  AuthOrchestrationOperateScope,
  isManagedDriverAllowed,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  LinkIcon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  groupOnboardingProjects,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
  type OnboardingProjectGroup,
  splitOnboardingProjectPath,
} from "../../onboarding/projectImport.logic";
import {
  getOnboardingProviderState,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { newProjectId, randomUUID } from "../../lib/utils";
import { agentSessionImport } from "../../state/agentSessions";
import { readProjects, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import {
  managedInstanceLocks,
  managedTelemetryOffMessage,
  usePrimaryManagedPolicy,
} from "../../state/managedPolicy";
import {
  isOnboardingRelayEnvironment,
  resolveOnboardingSetup,
} from "../../onboarding/targetEnvironment.logic";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { getProviderSummary } from "../settings/providerStatus";
import { providerClients } from "../settings/providerDriverMeta";
import { ChatGptWelcomeCoordinator } from "../settings/ChatGptWelcomeCoordinator";
import { AddManagedCodexAccountDialog, CodexSetupSection } from "../settings/CodexSetupSection";
import { readCodexSetupMode } from "../settings/CodexSetupSection.logic";
import { buildProviderInstanceUpdatePatch } from "../settings/SettingsPanels.logic";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { presentSavedCloudEnvironmentConnection } from "../cloud/cloudEnvironmentConnectionPresentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { T3Wordmark } from "../T3Wordmark";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CommandBlock } from "../CommandBlock";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { WizardPanel, WizardSteps, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { ImportStep } from "./WelcomeWizardParts";
export * from "./WelcomeWizardPairing";
import { AgentsStep } from "./WelcomeWizardAgents";
import { ConnectAccountOption, PairingForm } from "./WelcomeWizardPairing";
import { StepShell } from "./welcomeWizardShared";
export { StepShell } from "./welcomeWizardShared";
export * from "./WelcomeWizardAgents";

type WizardStep = "connection" | "agents" | "import";
const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];

const ONBOARDING_STAGES = ["Connect", "Agents", "Projects"] as const;
export const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";

export function WelcomeWizard({
  localAvailable,
  onDone,
  resumeEnvironmentId,
}: {
  readonly localAvailable: boolean;
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const [step, setStep] = useState<WizardStep>(resumeEnvironmentId ? "agents" : "connection");
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  // Share the registry for the wizard's lifetime so unchecked computers are not auto-selected again.
  const [autoSelectedComputers] = useState(() => new Set<EnvironmentId>());
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>(
    resumeEnvironmentId ? [resumeEnvironmentId] : [],
  );
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks newly listed computers in the shared auto-select registry once and selects the enabled ones
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.add(environment.environmentId);
    }
    const enabledComputers = newComputers.filter((environment) => environment.entry.enabled);
    if (enabledComputers.length === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- The registry marks each computer once, and only after commit; render must not mutate it.
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...enabledComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [autoSelectedComputers, environments]);
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

    const completion = completeOnboarding()
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        await onDone(projectRef);
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

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(_, event) => {
        event.cancel();
        if (event.reason === "close-press" && !isImporting) void finish();
      }}
    >
      <WizardPopup
        size="wide"
        bottomStickOnMobile={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <WizardHeader
          title="Set up T3 Code"
          identity={
            <div className="flex items-baseline gap-1.5" role="img" aria-label="T3 Code">
              <T3Wordmark className="h-4 w-auto shrink-0" aria-hidden />
              <span className="text-2xl font-medium tracking-tight text-muted-foreground">
                Code
              </span>
            </div>
          }
        >
          <WizardSteps
            steps={ONBOARDING_STAGES}
            currentStep={stageIndex}
            isStepDisabled={(index) => isImporting || index >= stageIndex}
            onStepChange={(index) => {
              if (isImporting || index > stageIndex) return;
              setStep(index === 0 ? "connection" : "agents");
            }}
          />
        </WizardHeader>

        <WizardPanel holdHeight={isLoadingProjects}>
          {step === "connection" ? (
            <ConnectionStep
              expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
              selectedIds={selectedIds}
              autoSelectedComputers={autoSelectedComputers}
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
                startSetup(resolveOnboardingSetup(environments, selectedIds).environmentIds)
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
              importSelection={importSelection}
              onImportSelectionChange={setImportSelection}
              isImporting={isImporting}
              setIsImporting={setIsImporting}
              onDone={finish}
            />
          )}
        </WizardPanel>
      </WizardPopup>
      <ChatGptWelcomeCoordinator />
    </Dialog>
  );
}

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
  const telemetryOff = managedTelemetryOffMessage(usePrimaryManagedPolicy());
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const { ready, skippedIds } = resolveOnboardingSetup(environments, selectedIds);
  const skippedLabels = environments
    .filter((environment) => skippedIds.includes(environment.environmentId))
    .map((environment) => environment.label);
  const continueRef = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the Continue button once setup is ready and nothing else holds focus
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
                    {!environment.entry.enabled && environment.connection.phase !== "unsupported"
                      ? "Off"
                      : presentSavedCloudEnvironmentConnection(environment.connection).buttonLabel}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
                {environment.connection.phase === "unsupported" && environment.connection.error ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {environment.connection.error}
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
        <div className="rounded-lg border border-border bg-background">
          <Collapsible open={pairingOpen} onOpenChange={setPairingOpen}>
            <CollapsibleTrigger
              disabled={isPairing}
              render={
                <Button
                  variant="ghost"
                  size="sm-multiline"
                  className="min-h-14 w-full justify-start"
                />
              }
            >
              <LinkIcon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">Add a computer</span>
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
      </div>
      {skippedLabels.length > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Not connected, so setup skips {skippedLabels.join(", ")}. You can set{" "}
          {skippedLabels.length === 1 ? "it" : "them"} up later from Settings.
        </p>
      ) : null}
      <div className="mt-6 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          {telemetryOff ?? "T3 Code collects anonymous usage data to help us improve it."} To read
          more about how your data is used{telemetryOff === undefined ? " and how to opt out" : ""},
          see our{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            privacy policy
          </a>
          .
        </p>
        <Button
          className="shrink-0 self-end"
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
export const IMPORT_PERMISSION_MESSAGE = "This connection cannot import projects or thread history.";

export interface ImportSelection {
  // Computers whose projects were listed when the selection changed; later ones get the defaults.
  readonly environmentIds: ReadonlySet<EnvironmentId>;
  readonly keys: ReadonlySet<string>;
}

type ImportCandidate = AgentSessionProjectCandidate & {
  readonly environmentId: EnvironmentId;
  readonly key: string;
};

export function ImportCandidateList({
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
