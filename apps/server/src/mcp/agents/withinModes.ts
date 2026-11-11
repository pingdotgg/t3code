import type {
  GatewayProfile,
  GatewayRuntimePort,
  GatewayThreadControlAction,
} from "@t3tools/client-runtime/gateway";
import { ProviderInteractionMode, RuntimeMode, type ScheduledTask } from "@t3tools/contracts";
import { GatewayError } from "@t3tools/mcp-gateway";
import * as Schema from "effect/Schema";

import {
  type DispatchModes,
  exceededDispatchModeLimit,
} from "../../orchestration-v2/DispatchModeLimit.ts";

const isThreadModes = Schema.is(
  Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
);

const STARTS_WORK: ReadonlySet<GatewayThreadControlAction> = new Set([
  "resume",
  "retry",
  "restart",
]);

/** What a chat needs to make an edit, or anything else, without the user approving it. */
const EDITS: DispatchModes = { runtimeMode: "auto-accept-edits", interactionMode: "default" };
const ANYTHING: DispatchModes = { runtimeMode: "full-access", interactionMode: "default" };

const READ_OPERATIONS: ReadonlySet<string> = new Set(["git.status", "git.diff"]);

const refusal = (message: string) =>
  new GatewayError({ code: "scope_required", message, retryable: false });

const notFound = (message: string) =>
  new GatewayError({ code: "invalid_input", message, retryable: false });

const profileModes = (
  profile: Pick<GatewayProfile, "runtimeMode" | "interactionMode">,
): DispatchModes => ({
  runtimeMode: profile.runtimeMode === "read-only" ? "approval-required" : profile.runtimeMode,
  interactionMode: profile.interactionMode,
});

/**
 * A port that refuses, on any environment, what the calling chat could not do itself at `limit`:
 * creating, starting, steering or scheduling work above it; changing an agent or skill that runs
 * above it; approving an action it would need approval for; and changing a repository directly.
 * Stopping work, declining approvals and deleting scheduled tasks stay open: they are the way out.
 */
export const withinModes = (port: GatewayRuntimePort, limit: DispatchModes): GatewayRuntimePort => {
  if (limit.runtimeMode === "full-access" && limit.interactionMode === "default") return port;
  const check = (
    what: string,
    modes: { readonly runtimeMode?: unknown; readonly interactionMode?: unknown },
  ) => {
    if (!isThreadModes(modes)) {
      throw refusal(
        `${what} does not report its modes, so they cannot be checked against this chat's.`,
      );
    }
    const exceeded = exceededDispatchModeLimit(limit, modes);
    if (exceeded !== undefined) {
      throw refusal(
        exceeded === "runtime"
          ? `${what} runs in ${modes.runtimeMode}, broader than this chat's ${limit.runtimeMode}.`
          : `${what} runs in ${modes.interactionMode} mode, broader than this chat's ${limit.interactionMode} mode.`,
      );
    }
  };
  /** What the gateway does directly, with no approval prompt, needs the mode that skips one. */
  const need = (what: string, required: DispatchModes) => {
    const exceeded = exceededDispatchModeLimit(limit, required);
    if (exceeded !== undefined) {
      throw refusal(
        exceeded === "runtime"
          ? `${what} needs ${required.runtimeMode}, broader than this chat's ${limit.runtimeMode}.`
          : `${what} is not open to a chat in ${limit.interactionMode} mode.`,
      );
    }
  };
  const checkThread = async (environmentId: string, threadId: string) =>
    check(`Thread ${threadId}`, await port.getThread(environmentId, threadId));
  const profiles = async (environmentId: string) =>
    (await port.listProfiles?.(environmentId)) ?? [];
  const existingProfile = async (environmentId: string, profileId: string) => {
    const profile = (await profiles(environmentId)).find(
      (candidate) => candidate.profileId === profileId,
    );
    if (profile === undefined) {
      throw notFound(`Agent ${profileId} was not found on environment ${environmentId}.`);
    }
    check(`Agent ${profileId}`, profileModes(profile));
    return profile;
  };
  const checkSkillUsers = async (environmentId: string, skillId: string) => {
    for (const profile of await profiles(environmentId)) {
      if (profile.skillIds?.includes(skillId)) {
        check(
          `Agent ${profile.profileId ?? profile.name}, which uses skill ${skillId},`,
          profileModes(profile),
        );
      }
    }
  };

  const {
    handoffThread,
    respondToUserInput,
    executeOperation,
    scheduledTask,
    createProfile,
    updateProfile,
    deleteProfile,
    updateSkill,
    deleteSkill,
  } = port;
  // Runs at the task's stored modes, or its bound thread's (see ScheduledTaskService.dispatchRun).
  const checkScheduledTask = async (environmentId: string, taskId: string) => {
    const listed = (await scheduledTask!.call(port, environmentId, { action: "list" })) as {
      readonly tasks?: ReadonlyArray<ScheduledTask>;
    };
    const task = listed.tasks?.find((candidate) => candidate.id === taskId);
    if (task === undefined) {
      throw notFound(`Scheduled task ${taskId} was not found on environment ${environmentId}.`);
    }
    check(`Scheduled task ${taskId}`, task);
    if (task.threadId === null) return;
    // A deleted bound thread is replaced at the task's own modes, checked above.
    const bound = await port.getThread(environmentId, task.threadId).catch(() => undefined);
    if (bound !== undefined) check(`Scheduled task ${taskId}'s thread ${task.threadId}`, bound);
  };

  return {
    ...port,
    createThread: async (input) => {
      check(`The new thread ${input.threadId}`, input);
      return port.createThread(input);
    },
    sendMessage: async (input) => {
      await checkThread(input.environmentId, input.threadId);
      return port.sendMessage(input);
    },
    controlThread: async (input) => {
      if (STARTS_WORK.has(input.action)) await checkThread(input.environmentId, input.threadId);
      return port.controlThread(input);
    },
    // An approval lets the thread take the action now, so the chat must be able to take it itself.
    respondToApproval: async (input) => {
      if (input.decision === "accept" || input.decision === "acceptForSession") {
        const thread = await port.getThread(input.environmentId, input.threadId);
        const pending = Array.isArray(thread.pendingApprovals) ? thread.pendingApprovals : [];
        const approval = pending.find(
          (candidate: { readonly requestId?: unknown }) =>
            candidate?.requestId === input.approvalRequestId,
        ) as { readonly requestKind?: unknown } | undefined;
        const kind = typeof approval?.requestKind === "string" ? approval.requestKind : "command";
        need(
          `Approving this ${kind} request`,
          kind === "file-change" || kind === "file-read" ? EDITS : ANYTHING,
        );
      }
      return port.respondToApproval(input);
    },
    ...(respondToUserInput === undefined
      ? {}
      : {
          respondToUserInput: async (input) => {
            await checkThread(input.environmentId, input.threadId);
            return respondToUserInput.call(port, input);
          },
        }),
    ...(executeOperation === undefined
      ? {}
      : {
          executeOperation: async (input) => {
            const { operation, payload } = input;
            if (operation === "pr.apply_review_fixes") {
              // Queues a turn in that thread, at that thread's modes.
              await checkThread(input.environmentId, String(payload.threadId));
            } else if (
              !READ_OPERATIONS.has(operation) &&
              !(operation === "worktree.reclaim" && payload.dryRun === true)
            ) {
              need(`Running ${operation}`, operation === "git.apply_patch" ? EDITS : ANYTHING);
            }
            return executeOperation.call(port, input);
          },
        }),
    ...(scheduledTask === undefined
      ? {}
      : {
          scheduledTask: async (environmentId, request) => {
            if (request.action === "create") {
              await existingProfile(environmentId, request.input.profileId);
            } else if (request.action === "update" || request.action === "run") {
              await checkScheduledTask(environmentId, request.taskId);
              if (request.action === "update" && request.patch.profileId !== undefined) {
                await existingProfile(environmentId, request.patch.profileId);
              }
            }
            return scheduledTask.call(port, environmentId, request);
          },
        }),
    ...(handoffThread === undefined
      ? {}
      : {
          handoffThread: async (input) => {
            await existingProfile(input.environmentId, input.profileId);
            return handoffThread.call(port, input);
          },
        }),
    ...(createProfile === undefined
      ? {}
      : {
          createProfile: async (environmentId, profile) => {
            check(`The new agent ${profile.name}`, profileModes(profile));
            return createProfile.call(port, environmentId, profile);
          },
        }),
    ...(updateProfile === undefined
      ? {}
      : {
          updateProfile: async (environmentId, profileId, patch) => {
            const existing = await existingProfile(environmentId, profileId);
            check(
              `Agent ${profileId} as changed`,
              profileModes({
                runtimeMode: patch.runtimeMode ?? existing.runtimeMode,
                interactionMode: patch.interactionMode ?? existing.interactionMode,
              }),
            );
            return updateProfile.call(port, environmentId, profileId, patch);
          },
        }),
    ...(deleteProfile === undefined
      ? {}
      : {
          deleteProfile: async (environmentId, profileId) => {
            await existingProfile(environmentId, profileId);
            return deleteProfile.call(port, environmentId, profileId);
          },
        }),
    ...(updateSkill === undefined
      ? {}
      : {
          updateSkill: async (environmentId, skillId, patch) => {
            await checkSkillUsers(environmentId, skillId);
            return updateSkill.call(port, environmentId, skillId, patch);
          },
        }),
    ...(deleteSkill === undefined
      ? {}
      : {
          deleteSkill: async (environmentId, skillId) => {
            await checkSkillUsers(environmentId, skillId);
            return deleteSkill.call(port, environmentId, skillId);
          },
        }),
  };
};
