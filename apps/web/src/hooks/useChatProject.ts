import { CHAT_PROJECT_TITLE, findChatProject } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { newProjectId } from "~/lib/utils";
import { readProjects, waitForProject } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

// One create per environment at a time: a second click while the first
// project.create is in flight would be rejected as a duplicate workspace root.
const inFlightByEnvironment = new Map<EnvironmentId, Promise<EnvironmentProject | null>>();

async function waitForChatProject(
  find: () => EnvironmentProject | null,
  attempts = 12,
  intervalMs = 250,
): Promise<EnvironmentProject | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const project = find();
    if (project) return project;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return null;
}

function reportChatStartFailure(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Failed to start chat",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * "Just chat" runs a thread in a plain folder the server offers instead of a
 * repository. That folder becomes an ordinary project the first time it is
 * used, so everything downstream is the regular non-git project path.
 */
export function useChatProject() {
  const { environments } = useEnvironments();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const chatWorkspaceRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null =>
      environments.find((entry) => entry.environmentId === environmentId)?.serverConfig
        ?.chatWorkspaceRoot ?? null,
    [environments],
  );

  /** Whether "Just chat" can be started in this environment right now. */
  const canStartChatIn = useCallback(
    (environmentId: EnvironmentId | null): boolean =>
      environments.some(
        (entry) =>
          entry.environmentId === environmentId &&
          entry.connection.phase === "connected" &&
          entry.serverConfig?.chatWorkspaceRoot !== undefined,
      ),
    [environments],
  );

  // The hosted web app has no primary environment, so "Just chat" targets the
  // first connected environment that offers a chats folder.
  const chatEnvironmentId = useCallback(
    (preferred: EnvironmentId | null): EnvironmentId | null =>
      canStartChatIn(preferred)
        ? preferred
        : (environments.find((entry) => canStartChatIn(entry.environmentId))?.environmentId ??
          null),
    [canStartChatIn, environments],
  );

  const ensureChatProject = useCallback(
    (environmentId: EnvironmentId): Promise<EnvironmentProject | null> => {
      const chatWorkspaceRoot = chatWorkspaceRootFor(environmentId);
      if (chatWorkspaceRoot === null || !canStartChatIn(environmentId)) {
        return Promise.resolve(null);
      }
      const findExisting = () =>
        findChatProject({ projects: readProjects(), environmentId, chatWorkspaceRoot });
      const existing = findExisting();
      if (existing) return Promise.resolve(existing);
      const pending = inFlightByEnvironment.get(environmentId);
      if (pending) return pending;

      const create = (async () => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: CHAT_PROJECT_TITLE,
            workspaceRoot: chatWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return null;
          // Another client may have created it first. Its project event can
          // land after this rejection, so give the store a moment to catch up.
          const raced = await waitForChatProject(findExisting);
          if (raced) return raced;
          reportChatStartFailure(squashAtomCommandFailure(result));
          return null;
        }
        // Drafts key off the project's stored path and settings, so wait for
        // the create event to reach the client store before targeting one.
        try {
          return await waitForProject({ environmentId, projectId });
        } catch {
          reportChatStartFailure(new Error("The chat project has not reached this client yet."));
          return null;
        }
      })().finally(() => {
        inFlightByEnvironment.delete(environmentId);
      });
      inFlightByEnvironment.set(environmentId, create);
      return create;
    },
    [canStartChatIn, chatWorkspaceRootFor, createProject],
  );

  return { canStartChatIn, chatEnvironmentId, chatWorkspaceRootFor, ensureChatProject };
}
