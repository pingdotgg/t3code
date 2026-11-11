import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AgentSessionListed,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";

import { useEnvironmentScope, readEnvironmentScope } from "~/state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { agentSessionAdopt, agentSessionList } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface ClaudeSessionProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The import operation failed.",
  });
}

interface ClaudeSessionAdoptProps {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<ClaudeSessionProject>;
  readonly readOnly: boolean;
  /** When set, skip the project picker and import for this project only. */
  readonly lockedProjectId?: ProjectId;
}

export function ClaudeSessionAdoptSection(props: ClaudeSessionAdoptProps) {
  const locked =
    props.lockedProjectId !== undefined
      ? (props.projects.find((project) => project.id === props.lockedProjectId) ?? null)
      : null;
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(locked?.id ?? null);
  const projectId =
    locked?.id ??
    props.projects.find((project) => project.id === selectedProjectId)?.id ??
    props.projects[0]?.id ??
    null;
  if (locked === null && selectedProjectId !== projectId) setSelectedProjectId(projectId);

  return (
    <ProjectSessionAdopt
      key={JSON.stringify([props.environmentId, projectId, locked?.id ?? null])}
      {...props}
      projectId={projectId}
      onProjectChange={setSelectedProjectId}
      projectSelectHidden={locked !== null}
    />
  );
}

function ProjectSessionAdopt(
  props: ClaudeSessionAdoptProps & {
    readonly projectId: ProjectId | null;
    readonly onProjectChange: (projectId: ProjectId) => void;
    readonly projectSelectHidden: boolean;
  },
) {
  const navigate = useNavigate();
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const { projectId } = props;
  const projectGeneration = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Late continuations must not act on a replaced project scope.
  useLayoutEffect(() => {
    return () => {
      projectGeneration.current += 1;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retiring a project invalidates its pending operations even when the instance stays mounted.
  }, [projectId]);
  const [sessions, setSessions] = useState<ReadonlyArray<AgentSessionListed>>([]);
  const [loading, setLoading] = useState(false);
  const [adoptingSessionId, setAdoptingSessionId] = useState<string | null>(null);
  const [previousProjectId, setPreviousProjectId] = useState(projectId);
  if (previousProjectId !== projectId) {
    setPreviousProjectId(projectId);
    setSessions([]);
    setLoading(false);
    setAdoptingSessionId(null);
  }
  const listSessions = useAtomCommand(agentSessionList, { reportFailure: false });
  const adoptSession = useAtomCommand(agentSessionAdopt, { reportFailure: false });

  const openAdoptedThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  const loadSessions = async () => {
    const generation = projectGeneration.current;
    if (projectId === null || loading) return;
    setLoading(true);
    const result = await listSessions({
      environmentId: props.environmentId,
      input: { projectId, provider: "claudeAgent" },
    });
    if (generation !== projectGeneration.current) return;
    setLoading(false);
    if (result._tag === "Success") {
      setSessions(result.value.sessions);
      return;
    }
    reportFailure("Could not list Claude sessions", result);
  };

  const adoptListedSession = async (session: AgentSessionListed) => {
    const generation = projectGeneration.current;
    if (session.importedThreadId !== null) {
      openAdoptedThread(session.importedThreadId);
      return;
    }
    if (
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope) ||
      projectId === null ||
      adoptingSessionId !== null
    )
      return;
    setAdoptingSessionId(session.providerSessionId);
    const result = await adoptSession({
      environmentId: props.environmentId,
      input: {
        projectId,
        provider: "claudeAgent",
        providerInstanceId: session.providerInstanceId,
        providerSessionId: session.providerSessionId,
        title: session.title,
      },
    });
    if (generation !== projectGeneration.current) return;
    setAdoptingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.map((candidate) =>
          candidate.providerSessionId === session.providerSessionId
            ? { ...candidate, importedThreadId: result.value.threadId }
            : candidate,
        ),
      );
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: result.value.adopted
            ? "Claude session imported"
            : "Claude session already imported",
        }),
      );
      openAdoptedThread(result.value.threadId);
      return;
    }
    reportFailure("Could not import Claude session", result);
  };

  return (
    <SettingsSection id="import-claude-sessions" title="Import Claude sessions">
      <SettingsRow
        title="Existing Claude Code sessions"
        description={
          props.projects.length === 0
            ? "Add a project before importing Claude Code sessions from disk."
            : "Discover Claude Code sessions for this project and import one into a T3 thread without starting a new conversation. Distinct from connecting Claude as an outside MCP app."
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {props.projects.length > 0 ? (
              <>
                {props.projectSelectHidden ? null : (
                  <Select
                    value={projectId ?? ""}
                    disabled={!canRead || loading || adoptingSessionId !== null}
                    onValueChange={(value) => {
                      if (value === null) return;
                      props.onProjectChange(value as ProjectId);
                    }}
                  >
                    <SelectTrigger
                      aria-label="Project for Claude sessions"
                      className="w-40"
                      size="sm"
                    >
                      <SelectValue>
                        {props.projects.find((project) => project.id === projectId)?.title}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {props.projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canRead || loading || projectId === null || props.readOnly}
                  onClick={() => void loadSessions()}
                >
                  {loading ? "Loading" : sessions.length === 0 ? "Discover" : "Refresh"}
                </Button>
              </>
            ) : null}
          </div>
        }
      >
        {sessions.length > 0 ? (
          <div className="divide-y divide-border/60 border-y border-border/60">
            {sessions.map((session) => (
              <div
                key={`${session.providerInstanceId}:${session.providerSessionId}`}
                className="flex min-w-0 items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs text-foreground">{session.title}</p>
                  <code className="block truncate text-3xs text-muted-foreground">
                    {session.providerSessionId}
                  </code>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  disabled={
                    props.readOnly ||
                    (!canOperate && session.importedThreadId === null) ||
                    adoptingSessionId !== null
                  }
                  onClick={() => void adoptListedSession(session)}
                >
                  {session.importedThreadId !== null
                    ? "Open"
                    : adoptingSessionId === session.providerSessionId
                      ? "Importing"
                      : "Import"}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
