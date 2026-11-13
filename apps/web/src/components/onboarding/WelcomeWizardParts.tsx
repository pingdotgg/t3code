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
import type { ImportSelection } from "./WelcomeWizard";
import { IMPORT_PERMISSION_MESSAGE, ImportCandidateList, SCAN_LIMIT_MESSAGE, StepShell } from "./WelcomeWizard";

export function ImportStep({
  scans,
  importSelection,
  onImportSelectionChange,
  isImporting,
  setIsImporting,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly importSelection: ImportSelection | null;
  readonly onImportSelectionChange: (next: ImportSelection) => void;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount?: number,
  ) => Promise<boolean>;
}) {
  const { environments } = useEnvironments();
  const writableEnvironments = useEnvironmentsWithScope(scans, AuthOrchestrationOperateScope);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const importWarningRef = useRef("");
  const importedThreadCountRef = useRef(0);
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

  const { available: candidates, recent } = partitionOnboardingProjects(
    scans.flatMap((scan) =>
      (scan.data?.candidates ?? []).map((candidate) => ({
        ...candidate,
        environmentId: scan.environmentId,
        key: onboardingProjectKey(scan.environmentId, candidate.path),
      })),
    ),
  );
  const recentKeys = new Set(recent.map((candidate) => candidate.key));
  const selected = candidates.filter((candidate) =>
    importSelection?.environmentIds.has(candidate.environmentId)
      ? importSelection.keys.has(candidate.key)
      : recentKeys.has(candidate.key),
  );
  const selectedKeys = new Set(selected.map((candidate) => candidate.key));
  const setSelectedKeys = (keys: ReadonlySet<string>) =>
    onImportSelectionChange({
      environmentIds: new Set(
        scans.flatMap((scan) => (scan.data === null ? [] : [scan.environmentId])),
      ),
      keys,
    });

  const canImport = selected.every((candidate) =>
    writableEnvironments.has(candidate.environmentId),
  );
  const [importError, setImportError] = useState("");
  const visibleImportError = !canImport
    ? IMPORT_PERMISSION_MESSAGE
    : importError === IMPORT_PERMISSION_MESSAGE
      ? ""
      : importError;

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    if (projectRef === undefined) {
      void onDone(undefined, importWarningRef.current, importedThreadCountRef.current);
      return;
    }
    setIsImporting(true);
    const importGeneration = importGenerationRef.current;
    // waitForProject gives up after its timeout, so a project that never reaches the client
    // still finishes setup, just without landing in it.
    void waitForProject(projectRef)
      .then(
        () => projectRef,
        () => undefined,
      )
      .then(async (landing) => {
        if (importGeneration !== importGenerationRef.current) return;
        const completed = await onDone(
          landing,
          importWarningRef.current,
          importedThreadCountRef.current,
        );
        if (!completed) setIsImporting(false);
      });
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    const hasAccess = () =>
      selection.every((candidate) =>
        readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope),
      );
    const stopForDeniedAccess = () => {
      setIsImporting(false);
      setImportError(IMPORT_PERMISSION_MESSAGE);
    };
    if (!hasAccess()) {
      stopForDeniedAccess();
      return;
    }
    if (selection.length === 0) {
      void onDone();
      return;
    }
    setIsImporting(true);
    importWarningRef.current = "";
    importedThreadCountRef.current = 0;
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
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
      if (!hasAccess()) {
        stopForDeniedAccess();
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

      if (!hasAccess()) {
        stopForDeniedAccess();
        return;
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
    importedThreadCountRef.current = importedThreadCount;
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

  if (scans.every((scan) => scan.data === null) && scans.some((scan) => scan.isPending)) {
    return (
      <div className="flex h-full min-h-40 flex-col">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Your projects</h1>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6">
          <Spinner size="lg" tone="muted" />
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
      title="Import your projects"
      description="Import projects and conversations from Claude Code and Codex on your selected computers."
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
              onClick={() => setSelectedKeys(new Set(candidates.map((item) => item.key)))}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={isImporting || selected.length === 0}
              onClick={() => setSelectedKeys(new Set())}
            >
              Select none
            </Button>
          </div>
        </div>
      ) : null}
      <ScrollArea scrollFade className="mt-2 h-auto max-h-80">
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
                    <Spinner size="md" />
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
                  onSelectionChange={setSelectedKeys}
                />
              </fieldset>
            );
          })}
        </div>
      </ScrollArea>
      {visibleImportError ? (
        <p className="mt-3 text-sm text-destructive">{visibleImportError}</p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <Button variant="ghost-muted" disabled={isImporting} onClick={finishAfterImport}>
          Do not import projects
        </Button>
        <Button
          autoFocus
          disabled={!canImport || isImporting || selected.length === 0}
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

