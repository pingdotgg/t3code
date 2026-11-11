import { useState, type CSSProperties } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  createGatewayRuntimePortFromContext,
  resolveGatewayProfileModelSelection,
} from "@t3tools/client-runtime/gateway";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ProviderInstanceId,
  type McpGatewayProfile,
  type ThreadProfileSelection,
} from "@t3tools/contracts";
import { withReasoningEffortOption } from "@t3tools/shared/model";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { newDraftId, newThreadId, randomUUID } from "../../lib/utils";
import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import ChatView from "../ChatView";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { agentMachineUnavailableReason } from "./agentMachineAvailability";
import { agentColorFor, resolveAgentTaskProject } from "./agents.logic";
import { AgentIcon } from "./AgentIcon";
import {
  collapsedNewChatChoices,
  defaultNewChatMachine,
  defaultNewChatProfile,
  emptyNewChatHistory,
  filterNewChatProjects,
  NewChatHistory,
  recordNewChat,
  sortProfilesByNewChatPick,
  sortProjectsByNewChatPick,
} from "./agentNewChat.logic";

const NEW_CHAT_HISTORY_KEY = "t3code:agents:new-chat-history";
const COLLAPSED_CHOICES = 4;

const useNewChatHistory = () =>
  useLocalStorage(NEW_CHAT_HISTORY_KEY, emptyNewChatHistory, NewChatHistory);

function ShowMoreChoices({
  total,
  expanded,
  onToggle,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (total <= COLLAPSED_CHOICES) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="mt-2"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <ChevronDownIcon className={expanded ? "rotate-180" : undefined} />
      {expanded ? "Show less" : `Show ${total - COLLAPSED_CHOICES} more`}
    </Button>
  );
}

/**
 * New chat from the Agents board. Opens on Captain (or the first agent that can
 * start chats) and the machine the last new chat was created on, so the usual
 * path is: pick a project card, type the task.
 */
export function AgentTaskDialog({
  profiles,
  orderedProfiles,
  onClose,
}: {
  /** Library order, which agent colors are derived from. */
  profiles: readonly McpGatewayProfile[];
  /** The board's column order, which never-picked agent cards keep. */
  orderedProfiles: readonly McpGatewayProfile[];
  onClose: () => void;
}) {
  const [profileId, setProfileId] = useState(
    () => defaultNewChatProfile(orderedProfiles)?.profileId,
  );
  const profile =
    orderedProfiles.find((item) => item.profileId === profileId) ??
    defaultNewChatProfile(orderedProfiles);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const busy = creating || sending;
  const hasContent = useComposerDraftStore((store) => {
    const session = profile
      ? store.getDraftSessionByLogicalProjectKey(`agent-task:${profile.profileId}`)
      : null;
    const draft = session ? store.draftsByThreadKey[session.draftId] : null;
    return composerDraftHasUserContent(draft) || (draft?.nonPersistedImageIds.length ?? 0) > 0;
  });
  const [history] = useNewChatHistory();
  const [showAllAgents, setShowAllAgents] = useState(false);
  const sortedProfiles = sortProfilesByNewChatPick(orderedProfiles, history);
  const visibleProfiles = showAllAgents
    ? sortedProfiles
    : collapsedNewChatChoices(
        sortedProfiles,
        (item) => item.profileId === profile?.profileId,
        COLLAPSED_CHOICES,
      );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="w-[min(760px,calc(100vw-32px))] max-w-[760px]">
        <div className="agent-dialog p-6">
          <DialogTitle>New chat{profile ? ` · ${profile.name}` : ""}</DialogTitle>
          <DialogDescription className="mt-2">
            Pick an agent and a project, then give it a task.
          </DialogDescription>
          <fieldset className="agent-choice-group" disabled={busy || hasContent}>
            <legend>Agent</legend>
            <div className="agent-choice-grid">
              {visibleProfiles.map((item) => (
                <label
                  key={item.profileId}
                  className="agent-choice-card"
                  style={{ "--agent-color": agentColorFor(item, profiles) } as CSSProperties}
                >
                  <input
                    type="radio"
                    name="agent-task-agent"
                    className="sr-only"
                    value={item.profileId}
                    checked={item.profileId === profile?.profileId}
                    disabled={item.runtimeMode === "read-only"}
                    onChange={() => setProfileId(item.profileId)}
                  />
                  <AgentIcon icon={item.icon} iconId={item.iconId} />
                  <span className="agent-choice-body">
                    <span className="agent-choice-name">{item.name}</span>
                    {item.description && (
                      <span className="agent-choice-detail">{item.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <ShowMoreChoices
              total={sortedProfiles.length}
              expanded={showAllAgents}
              onToggle={() => setShowAllAgents((value) => !value)}
            />
          </fieldset>
          {profile ? (
            <AgentTaskForm
              key={profile.profileId}
              profile={profile}
              creating={creating}
              sending={sending}
              hasContent={hasContent}
              setCreating={setCreating}
              setSending={setSending}
              onClose={onClose}
            />
          ) : (
            <>
              <p role="alert" className="mt-4">
                No agent can start chats. Read-only agents only answer through MCP.
              </p>
              <div className="mt-4 flex justify-end">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function AgentTaskForm({
  profile,
  creating,
  sending,
  hasContent,
  setCreating,
  setSending,
  onClose,
}: {
  profile: McpGatewayProfile;
  creating: boolean;
  sending: boolean;
  hasContent: boolean;
  setCreating: (creating: boolean) => void;
  setSending: (sending: boolean) => void;
  onClose: () => void;
}) {
  const runtime = useAtomValue(connectionAtomRuntime);
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const projects = useProjects();
  const [history, setHistory] = useNewChatHistory();
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [initialDraft] = useState(() =>
    useComposerDraftStore
      .getState()
      .getDraftSessionByLogicalProjectKey(`agent-task:${profile.profileId}`),
  );
  // Empty until the user picks a machine or a project; until then the default may follow
  // machines connecting and disconnecting.
  const [chosenMachine, setMachine] = useState<string>(initialDraft?.environmentId ?? "");
  const [projectId, setProjectId] = useState<string>(initialDraft?.projectId ?? "");
  const [draftId] = useState(() => initialDraft?.draftId ?? newDraftId());
  const [threadId] = useState(() => initialDraft?.threadId ?? newThreadId());
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const [error, setError] = useState("");
  const busy = creating || sending;
  const machines = environments.map((env) => ({
    env,
    reason: agentMachineUnavailableReason(profile, {
      ...env,
      providers: providersByEnvironment.get(env.environmentId),
    }),
  }));
  const eligible = machines.filter(({ reason }) => reason === undefined).map(({ env }) => env);
  const machine =
    chosenMachine ||
    defaultNewChatMachine(
      eligible.map((env) => env.environmentId),
      history.machine,
    );
  const target = eligible.find((env) => env.environmentId === machine);
  const supportsAgentDrafts =
    target?.serverConfig?.environment.capabilities.agentThreadBootstrap === true;
  const targetProjects = sortProjectsByNewChatPick(
    projects.filter((project) => project.environmentId === machine),
    history,
  );
  const project = resolveAgentTaskProject(projects, machine, projectId);
  // A search covers every project on the machine, including those collapsed behind Show more.
  const searchingProjects = projectQuery.trim() !== "";
  const matchingProjects = filterNewChatProjects(targetProjects, projectQuery);
  const visibleProjects = searchingProjects
    ? matchingProjects
    : showAllProjects
      ? targetProjects
      : collapsedNewChatChoices(
          targetProjects,
          (item) => item.id === project?.id,
          COLLAPSED_CHOICES,
        );
  const modelSelection = target
    ? resolveGatewayProfileModelSelection(
        profile,
        providersByEnvironment.get(target.environmentId) ?? [],
      )
    : undefined;
  const profileSelection: ThreadProfileSelection = {
    profileId: profile.profileId,
    revision: profile.revision,
    // The normal composer starts with the agent's defaults and allows explicit changes.
    overrideFields: ["modelSelection", "runtimeMode", "interactionMode", "reasoningEffort"],
  };

  const selectProject = (nextProjectId: string) => {
    // A chosen project pins its machine; a default must not move the draft elsewhere.
    setMachine(machine);
    setProjectId(nextProjectId);
    setError("");
    const selected = resolveAgentTaskProject(projects, machine, nextProjectId);
    if (!selected || !modelSelection || profile.runtimeMode === "read-only") return;
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(
      `agent-task:${profile.profileId}`,
      scopeProjectRef(selected.environmentId, selected.id),
      draftId,
      {
        threadId,
        envMode: "local",
        environmentSelection: "manual",
        runtimeMode: profile.runtimeMode,
        interactionMode: profile.interactionMode,
      },
    );
    // V2 implicit drafts inherit project defaults; an agent starts with explicit profile choices.
    store.setRuntimeMode(draftId, profile.runtimeMode);
    store.setInteractionMode(draftId, profile.interactionMode);
    const options = withReasoningEffortOption(
      modelSelection.options,
      profile.reasoningEffort,
      (target ? providersByEnvironment.get(target.environmentId) : undefined)
        ?.find((provider) => provider.instanceId === modelSelection.instanceId)
        ?.models.find((model) => model.slug === modelSelection.model)?.capabilities
        ?.optionDescriptors,
    );
    store.setModelSelection(
      draftId,
      {
        instanceId: ProviderInstanceId.make(modelSelection.instanceId),
        model: modelSelection.model,
        ...(options ? { options } : {}),
      },
      { replaceOptions: true },
    );
  };
  const finish = () => {
    useComposerDraftStore.getState().clearDraftThread(draftId);
    // Open the new chat inside the Agents workspace instead of dropping the
    // user back on the board with nothing selected.
    const environmentId = target?.environmentId ?? draftSession?.environmentId;
    const projectId = project?.id ?? draftSession?.projectId;
    if (environmentId && projectId) {
      setHistory((current) =>
        recordNewChat(current, {
          profileId: profile.profileId,
          environmentId,
          projectId,
          at: new Date().toISOString(),
        }),
      );
    }
    onClose();
    if (environmentId) {
      void navigate({
        to: "/agents/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    }
  };
  return (
    <>
      <div className="agent-form">
        <label>
          Machine
          <select
            value={machine}
            disabled={busy || hasContent}
            onChange={(event) => {
              setMachine(event.target.value);
              setProjectId("");
            }}
          >
            <option value="" disabled>
              Select machine
            </option>
            {machines.map(({ env, reason }) => (
              <option
                key={env.environmentId}
                value={env.environmentId}
                disabled={reason !== undefined}
              >
                {env.label}
                {reason ? `: ${reason}` : ""}
              </option>
            ))}
          </select>
        </label>
        {!target && (
          <p role="alert">
            Select a connected machine that supports this agent's provider and model.
          </p>
        )}
        {eligible.length === 0 && (
          <div role="status" className="text-sm text-muted-foreground">
            {machines.length === 0 ? (
              <p>No machines configured. Add one in Settings → Connections.</p>
            ) : (
              machines.map(({ env, reason }) => (
                <p key={env.environmentId}>
                  {env.label}: {reason}
                </p>
              ))
            )}
          </div>
        )}
        {target && targetProjects.length > 0 && (
          <fieldset className="agent-choice-group" disabled={busy || hasContent}>
            <legend className="flex w-full items-center justify-between gap-3">
              Project
              <span className="w-56 max-w-[55%]">
                <Input
                  type="search"
                  size="compact"
                  aria-label="Search projects"
                  placeholder="Search projects"
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.target.value)}
                />
              </span>
            </legend>
            {searchingProjects && matchingProjects.length === 0 && (
              <p role="status" className="text-xs text-muted-foreground">
                No projects on {target.label} match &ldquo;{projectQuery.trim()}&rdquo;. Search
                covers project names and paths.
              </p>
            )}
            <div className="agent-choice-grid">
              {visibleProjects.map((item) => (
                <Tooltip key={item.id}>
                  <TooltipTrigger render={<label className="agent-choice-card" />}>
                    <input
                      type="radio"
                      name="agent-task-project"
                      className="sr-only"
                      value={item.id}
                      checked={project?.id === item.id}
                      onChange={() => selectProject(item.id)}
                    />
                    <ProjectFavicon project={item} className="mt-px size-4 shrink-0" />
                    <span className="agent-choice-body">
                      <span className="agent-choice-name">{item.title}</span>
                      <span className="agent-choice-detail">{item.workspaceRoot}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>{item.workspaceRoot}</TooltipPopup>
                </Tooltip>
              ))}
            </div>
            {!searchingProjects && (
              <ShowMoreChoices
                total={targetProjects.length}
                expanded={showAllProjects}
                onToggle={() => setShowAllProjects((value) => !value)}
              />
            )}
          </fieldset>
        )}
        {hasContent && (
          <p className="text-xs text-muted-foreground">
            Clear the draft to change its agent, machine or project.
          </p>
        )}
        {target && targetProjects.length === 0 && (
          <p>Add a project on {target.label} from the Threads view first.</p>
        )}
      </div>
      {target && !supportsAgentDrafts && (
        <p role="status">
          Update this machine’s T3 Agents server to send from this dialog. You can still create an
          empty chat.
        </p>
      )}
      {target &&
        supportsAgentDrafts &&
        project &&
        draftSession?.environmentId === target.environmentId &&
        draftSession.projectId === project.id &&
        profile.runtimeMode !== "read-only" && (
          <div className="agent-task-composer">
            <ChatView
              composerOnly
              autoFocusComposer
              routeKind="draft"
              draftId={draftId}
              environmentId={target.environmentId}
              threadId={draftSession.threadId}
              profileSelection={profileSelection}
              onSendBusyChange={setSending}
              onTurnStarted={finish}
            />
          </div>
        )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {hasContent && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              releaseComposerDraftUploads(draftId);
              useComposerDraftStore.getState().clearComposerContent(draftId);
            }}
          >
            Clear draft
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {!hasContent && (
          <Button
            disabled={
              busy ||
              !target ||
              !project ||
              runtime._tag !== "Success" ||
              profile.runtimeMode === "read-only"
            }
            onClick={async () => {
              if (busy || !target || !project || runtime._tag !== "Success") return;
              setCreating(true);
              setError("");
              try {
                const port = createGatewayRuntimePortFromContext(runtime.value);
                await port.createThread({
                  environmentId: target.environmentId,
                  projectId: project.id,
                  threadId,
                  title: "New thread",
                  requestId: randomUUID(),
                  profileSelection: {
                    profileId: profile.profileId,
                    revision: profile.revision,
                    overrideFields: [],
                  },
                });
                finish();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not create thread.");
              }
              setCreating(false);
            }}
          >
            {creating ? "Creating…" : "Create empty chat"}
          </Button>
        )}
      </div>
    </>
  );
}
