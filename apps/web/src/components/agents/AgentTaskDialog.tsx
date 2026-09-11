import { useState } from "react";
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
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { newDraftId, newThreadId, randomUUID } from "../../lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { agentMachineUnavailableReason } from "./agentMachineAvailability";
import { resolveAgentTaskProject } from "./agents.logic";

export function AgentTaskDialog({
  profile,
  onClose,
}: {
  profile: McpGatewayProfile;
  onClose: () => void;
}) {
  const runtime = useAtomValue(connectionAtomRuntime);
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [initialDraft] = useState(() =>
    useComposerDraftStore
      .getState()
      .getDraftSessionByLogicalProjectKey(`agent-task:${profile.profileId}`),
  );
  const [machine, setMachine] = useState<string>(initialDraft?.environmentId ?? "");
  const [projectId, setProjectId] = useState<string>(initialDraft?.projectId ?? "");
  const [draftId] = useState(() => initialDraft?.draftId ?? newDraftId());
  const [threadId] = useState(() => initialDraft?.threadId ?? newThreadId());
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const draft = useComposerDraftStore((store) => store.draftsByThreadKey[draftId]);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const busy = creating || sending;
  const machines = environments.map((env) => ({
    env,
    reason: agentMachineUnavailableReason(profile, env),
  }));
  const eligible = machines.filter(({ reason }) => reason === undefined).map(({ env }) => env);
  const target = eligible.find((env) => env.environmentId === machine);
  const supportsAgentDrafts =
    target?.serverConfig?.environment.capabilities.agentThreadBootstrap === true;
  const targetProjects = projects
    .filter((project) => project.environmentId === machine)
    .toSorted((a, b) => a.title.localeCompare(b.title));
  const project = resolveAgentTaskProject(projects, machine, projectId);
  const modelSelection = target
    ? resolveGatewayProfileModelSelection(profile, target.serverConfig?.providers ?? [])
    : undefined;
  const hasContent = Boolean(
    draft &&
    (draft.prompt.trim() ||
      draft.images.length ||
      draft.files.length ||
      draft.persistedAttachments.length ||
      draft.nonPersistedImageIds.length ||
      draft.terminalContexts.length ||
      draft.elementContexts.length ||
      draft.previewAnnotations.length ||
      draft.reviewComments.length),
  );
  const profileSelection: ThreadProfileSelection = {
    profileId: profile.profileId,
    revision: profile.revision,
    // The normal composer starts with the agent's defaults and allows explicit changes.
    overrideFields: ["modelSelection", "runtimeMode", "interactionMode", "reasoningEffort"],
  };

  const selectProject = (nextProjectId: string) => {
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
    store.setModelSelection(
      draftId,
      {
        instanceId: ProviderInstanceId.make(modelSelection.instanceId),
        model: modelSelection.model,
        ...(modelSelection.options ? { options: modelSelection.options } : {}),
        ...(profile.reasoningEffort
          ? {
              options: [
                ...(modelSelection.options ?? []).filter(
                  (option) => option.id !== "reasoningEffort",
                ),
                { id: "reasoningEffort", value: profile.reasoningEffort },
              ],
            }
          : {}),
      },
      { replaceOptions: true },
    );
  };
  const finish = () => {
    useComposerDraftStore.getState().clearDraftThread(draftId);
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="agent-dialog agent-task-dialog p-6">
        <DialogTitle>New chat · {profile.name}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          Choose where this chat runs, then give {profile.name} a task.
        </DialogDescription>
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
                  {reason ? ` — ${reason}` : ""}
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
          <label>
            Project
            <select
              required
              value={project?.id ?? ""}
              disabled={busy || hasContent || !target}
              onChange={(event) => selectProject(event.target.value)}
            >
              <option value="" disabled>
                Select project
              </option>
              {targetProjects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {project && <p className="text-xs text-muted-foreground">{project.workspaceRoot}</p>}
          {hasContent && (
            <p className="text-xs text-muted-foreground">
              Clear the draft to change its machine or project.
            </p>
          )}
          {target && targetProjects.length === 0 && (
            <p>Add a project on {target.label} from the Threads view first.</p>
          )}
        </div>
        {target && !supportsAgentDrafts && (
          <p role="status">
            Update this machine’s T3 Code server to send from this dialog. You can still create an
            empty chat.
          </p>
        )}
        {target &&
          supportsAgentDrafts &&
          project &&
          draftSession?.environmentId === target.environmentId &&
          draftSession.projectId === project.id &&
          profile.runtimeMode !== "read-only" && (
            <ChatView
              composerOnly
              routeKind="draft"
              draftId={draftId}
              environmentId={target.environmentId}
              threadId={draftSession.threadId}
              profileSelection={profileSelection}
              onSendBusyChange={setSending}
              onTurnStarted={finish}
            />
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
                } finally {
                  setCreating(false);
                }
              }}
            >
              {creating ? "Creating…" : "Create empty chat"}
            </Button>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
