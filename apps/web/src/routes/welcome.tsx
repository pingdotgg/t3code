import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, Link, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  ProviderDriverKind,
  type AgentSessionProjectCandidate,
  type AgentSessionSource,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button, InlineButton } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { newProjectId } from "../lib/utils";
import { agentSessionImport, agentSessionScan } from "../state/agentSessions";
import { readProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);
const SOURCE_NAMES: Record<AgentSessionSource, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

export const Route = createFileRoute("/welcome")({
  validateSearch: (raw: Record<string, unknown>) =>
    typeof raw.resumeEnvironmentId === "string" && raw.resumeEnvironmentId.trim()
      ? { resumeEnvironmentId: EnvironmentId.make(raw.resumeEnvironmentId) }
      : {},
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ImportConversationsPage,
});

function ImportConversationsPage() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const { resumeEnvironmentId } = Route.useSearch();
  const requestedEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : primaryEnvironmentId;
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const environment =
    environments.find(
      (entry) => entry.environmentId === (selectedEnvironmentId ?? requestedEnvironmentId),
    ) ?? connected[0];

  return (
    <>
      {hash === "setup" ? (
        <WelcomeWizard
          localAvailable={primaryEnvironmentId !== null}
          resumeEnvironmentId={resumeEnvironmentId}
          onDone={async () => {
            await navigate({ to: "/" });
          }}
        />
      ) : null}
      <StandalonePage>
        <StandalonePageHeader
          title="Import conversations"
          description="Bring your recent Claude Code, Codex and Pi conversations into T3 Code."
        />
        <div className="mt-6 flex flex-col gap-4">
          {environment ? (
            <>
              <Select
                value={environment.environmentId}
                items={environments.map((entry) => ({
                  value: entry.environmentId,
                  label: entry.label,
                }))}
                onValueChange={(value) => setSelectedEnvironmentId(value)}
              >
                <SelectTrigger aria-label="Import from environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {environment.connection.phase === "connected" ? (
                <EnvironmentImports
                  key={environment.environmentId}
                  environmentId={environment.environmentId}
                />
              ) : (
                <p className="text-body text-muted-foreground">
                  Connect this environment to import its conversations.
                </p>
              )}
            </>
          ) : (
            <p className="text-body text-muted-foreground">
              Connect an environment to import its conversations.
            </p>
          )}
          <p className="text-meta text-muted-foreground">
            Pi is off by default. Enable it in{" "}
            <InlineButton render={<Link to="/settings/providers" />}>
              provider settings
            </InlineButton>
            , then refresh. Imports use each enabled provider's session directory and resume Pi's
            active branch.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="standard"
              variant="ghost-muted"
              render={<Link to="/welcome" hash="setup" />}
            >
              Set up T3 Code
            </Button>
            <Button variant="secondary" render={<Link to="/" />}>
              Back to app
            </Button>
          </div>
        </div>
      </StandalonePage>
    </>
  );
}

function EnvironmentImports({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canImport = useAtomValue(agentSessionImport.permissionAtom(environmentId));
  const scan = useEnvironmentQuery(canRead ? agentSessionScan({ environmentId, input: {} }) : null);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const attempts = useRef(
    new Map<string, { projectId: ReturnType<typeof newProjectId>; commandId: CommandId }>(),
  );
  const pendingRef = useRef(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const importCandidate = async (candidate: AgentSessionProjectCandidate) => {
    if (pendingRef.current || !canImport) return;
    pendingRef.current = true;
    setPendingPath(candidate.path);
    setError(null);
    setSummary(null);
    const runImport = async () => {
      const project = findProjectByPath(
        readProjects().filter((entry) => entry.environmentId === environmentId),
        candidate.path,
      );
      let projectId = candidate.projectId ?? project?.id;
      if (projectId === undefined) {
        let attempt = attempts.current.get(candidate.path);
        if (attempt === undefined) {
          const id = newProjectId();
          attempt = { projectId: id, commandId: CommandId.make(`session-import:create:${id}`) };
          attempts.current.set(candidate.path, attempt);
        }
        projectId = attempt.projectId;
        const created = await createProject({
          environmentId,
          input: {
            ...attempt,
            title: candidate.title,
            workspaceRoot: candidate.path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (created._tag !== "Success") throw squashAtomCommandFailure(created);
      }
      const imported = await importThreads({
        environmentId,
        input: { projectId, expectedWorkspaceRoot: candidate.path },
      });
      if (imported._tag !== "Success") throw squashAtomCommandFailure(imported);
      setSummary(
        `${candidate.title}: ${imported.value.importedCount} imported, ${imported.value.skippedCount} skipped.`,
      );
    };
    await runImport().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not import conversations. Refresh and try again.",
      );
    });
    pendingRef.current = false;
    setPendingPath(null);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-label text-strong-foreground">Your projects</h2>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={!canRead || pendingPath !== null || scan.isPending}
          onClick={scan.refresh}
        >
          Refresh
        </Button>
      </div>
      {!canRead || !canImport ? (
        <p className="text-body text-muted-foreground">
          This connection cannot import projects or conversation history.
        </p>
      ) : null}
      {error || scan.error ? (
        <Alert variant="error">
          <AlertDescription>{error ?? scan.error}</AlertDescription>
        </Alert>
      ) : null}
      {summary ? (
        <p role="status" className="text-body text-foreground">
          {summary}
        </p>
      ) : null}
      {scan.isPending && scan.data === null ? (
        <p role="status" className="text-body text-muted-foreground">
          Looking for conversations…
        </p>
      ) : null}
      {scan.data?.truncated ? (
        <Alert variant="warning">
          <AlertDescription>
            The scan reached its limit. You can import the projects below or scan more to look
            further through your conversation history.
          </AlertDescription>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="standard"
              variant="secondary"
              disabled={pendingPath !== null || scan.isPending}
              onClick={scan.refresh}
            >
              {scan.isPending ? "Scanning…" : "Scan more"}
            </Button>
            <Button
              size="standard"
              variant="ghost-muted"
              render={<Link to="/settings/providers" />}
            >
              Check session folders
            </Button>
          </div>
        </Alert>
      ) : null}
      {scan.data?.candidates.length === 0 ? (
        <p className="text-body text-muted-foreground">
          No recent conversations found on this environment.
        </p>
      ) : null}
      <div className="flex flex-col divide-y divide-border">
        {scan.data?.candidates.map((candidate) => (
          <div key={candidate.path} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-label text-strong-foreground">{candidate.title}</h3>
              <Tooltip>
                <TooltipTrigger render={<p className="truncate text-meta text-muted-foreground" />}>
                  {candidate.path}
                </TooltipTrigger>
                <TooltipPopup>{candidate.path}</TooltipPopup>
              </Tooltip>
              <div className="mt-1 flex items-center gap-2 text-meta text-muted-foreground">
                {candidate.sources.map((source) => (
                  <span key={source} role="img" aria-label={SOURCE_NAMES[source]}>
                    <ProviderInstanceIcon
                      driverKind={ProviderDriverKind.make(source)}
                      displayName={SOURCE_NAMES[source]}
                      iconClassName="size-3.5"
                    />
                  </span>
                ))}
                <span>
                  {candidate.threadCount}{" "}
                  {candidate.threadCount === 1 ? "conversation" : "conversations"}
                </span>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={!canImport || pendingPath !== null}
              onClick={() => void importCandidate(candidate)}
              aria-label={`Import ${candidate.title}`}
            >
              {pendingPath === candidate.path ? "Importing…" : "Import"}
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
