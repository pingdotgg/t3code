import { createChannel } from "@copilotkit/channels-core";
import { discord } from "@copilotkit/channels-discord";
import {
  Actions,
  Button,
  Context,
  Field,
  Fields,
  Header,
  Message,
  Section,
} from "@copilotkit/channels-ui";
import type { Thread } from "@copilotkit/channels-ui";
import {
  CommandId,
  type DiscordChannelSettings,
  MessageId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const DISCORD_ACCENT = "#5865f2";
const COMPLETED_ACCENT = "#22c55e";
const FAILED_ACCENT = "#ef4444";
const MAX_TITLE_LENGTH = 72;
const MAX_BRANCH_SLUG_LENGTH = 40;

export interface ChannelTaskStatus {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly branch: string;
  readonly state: "queued" | "running" | "done" | "failed";
}

export interface StartedChannelTask extends ChannelTaskStatus {
  readonly state: "queued";
}

export interface T3CodeChannelOperations {
  readonly startTask: (
    prompt: string,
    config: DiscordChannelSettings,
  ) => Promise<StartedChannelTask>;
  readonly getTaskStatus: (threadId: ThreadId) => Promise<ChannelTaskStatus | null>;
}

interface LinkedConversationState {
  readonly t3ThreadId: string;
}

type ChannelThread = Pick<Thread, "post"> & {
  readonly state: () => Promise<unknown>;
  readonly setState: (value: unknown) => Promise<void>;
};

interface ActiveDiscordChannel {
  readonly fingerprint: string;
  readonly notifyCompleted: (input: {
    readonly threadId: ThreadId;
    readonly changedFileCount: number;
  }) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function isDiscordChannelConfigured(config: DiscordChannelSettings): boolean {
  return (
    config.enabled &&
    config.projectId !== null &&
    config.baseBranch.trim().length > 0 &&
    config.branchPrefix.trim().length > 0 &&
    config.applicationId.length > 0 &&
    config.botToken.length > 0
  );
}

export function channelBranchName(input: {
  readonly prefix: string;
  readonly prompt: string;
  readonly suffix: string;
}): string {
  const slug = input.prompt
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/gu, "");
  const prefix = input.prefix.replace(/^\/+|\/+$/gu, "");
  return `${prefix}/${slug || "task"}-${input.suffix}`;
}

function promptTitle(prompt: string): string {
  const singleLine = prompt.replace(/\s+/gu, " ").trim();
  return singleLine.length <= MAX_TITLE_LENGTH
    ? singleLine
    : `${singleLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function cleanDiscordPrompt(input: string): string {
  return input.replace(/<@!?\d+>/gu, "").trim();
}

function taskStateLabel(state: ChannelTaskStatus["state"]): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
  }
}

function statusCard(status: ChannelTaskStatus) {
  return Message({
    accent: status.state === "failed" ? FAILED_ACCENT : DISCORD_ACCENT,
    fallbackText: `${status.title}: ${taskStateLabel(status.state)}`,
    children: [
      Header({ children: status.title }),
      Fields({
        children: [
          Field({ label: "Status", children: taskStateLabel(status.state) }),
          Field({ label: "Branch", children: `\`${status.branch}\`` }),
        ],
      }),
      Context({
        children:
          "This task is running in an isolated worktree. The base branch is never checked out for agent work.",
      }),
    ],
  });
}

function startedCard(
  task: StartedChannelTask,
  onStatus: (thread: Pick<Thread, "post">) => Promise<void>,
) {
  return Message({
    accent: DISCORD_ACCENT,
    fallbackText: `T3 Code started: ${task.title}`,
    children: [
      Header({ children: "T3 Code task started" }),
      Section({ children: task.title }),
      Fields({
        children: [
          Field({ label: "Status", children: "Queued" }),
          Field({ label: "Branch", children: `\`${task.branch}\`` }),
        ],
      }),
      Actions({
        children: Button({
          style: "primary",
          value: task.threadId,
          onClick: ({ thread }) => onStatus(thread),
          children: "Check status",
        }),
      }),
      Context({ children: "T3 Code will reply here when the run and diff are complete." }),
    ],
  });
}

function completedCard(input: {
  readonly task: ChannelTaskStatus;
  readonly changedFileCount: number;
}) {
  const fileLabel = `${input.changedFileCount} changed ${input.changedFileCount === 1 ? "file" : "files"}`;
  return Message({
    accent: COMPLETED_ACCENT,
    fallbackText: `T3 Code finished: ${input.task.title}`,
    children: [
      Header({ children: "T3 Code finished" }),
      Section({ children: input.task.title }),
      Fields({
        children: [
          Field({ label: "Status", children: "Done" }),
          Field({ label: "Diff", children: fileLabel }),
          Field({ label: "Branch", children: `\`${input.task.branch}\`` }),
        ],
      }),
      Context({ children: "Open T3 Code to inspect the full transcript and diff." }),
    ],
  });
}

function createT3CodeChannel(input: {
  readonly config: DiscordChannelSettings;
  readonly operations: T3CodeChannelOperations;
}) {
  const linkedThreads = new Map<string, Pick<Thread, "post">>();
  const channel = createChannel({
    name: "t3-code",
    identifyUser: "platform",
    adapters: [
      discord({
        botToken: input.config.botToken,
        appId: input.config.applicationId,
        ...(input.config.guildId.length > 0 ? { guildId: input.config.guildId } : {}),
      }),
    ],
  });

  const postStatus = async (thread: Pick<Thread, "post">, threadId: ThreadId) => {
    const status = await input.operations.getTaskStatus(threadId);
    await thread.post(
      status
        ? statusCard(status)
        : Message({
            accent: FAILED_ACCENT,
            children: Section({ children: "That T3 Code task no longer exists." }),
          }),
    );
  };

  const handleText = async (thread: ChannelThread, rawText: string) => {
    const text = cleanDiscordPrompt(rawText);
    const storedState = await thread.state();
    const state =
      typeof storedState === "object" &&
      storedState !== null &&
      "t3ThreadId" in storedState &&
      typeof storedState.t3ThreadId === "string"
        ? ({ t3ThreadId: storedState.t3ThreadId } satisfies LinkedConversationState)
        : undefined;
    if (text.toLocaleLowerCase() === "status") {
      if (!state?.t3ThreadId) {
        await thread.post("No T3 Code task is linked to this Discord thread yet.");
        return;
      }
      await postStatus(thread, ThreadId.make(state.t3ThreadId));
      return;
    }
    if (text.length === 0) {
      await thread.post("Mention me with a coding task, or send `status` to check the linked run.");
      return;
    }

    if (state?.t3ThreadId) {
      const current = await input.operations.getTaskStatus(ThreadId.make(state.t3ThreadId));
      if (current?.state === "queued" || current?.state === "running") {
        await thread.post(statusCard(current));
        return;
      }
    }

    try {
      const task = await input.operations.startTask(text, input.config);
      await thread.setState({ t3ThreadId: task.threadId } satisfies LinkedConversationState);
      linkedThreads.set(task.threadId, thread);
      await thread.post(startedCard(task, (target) => postStatus(target, task.threadId)));
    } catch {
      await thread.post(
        Message({
          accent: FAILED_ACCENT,
          fallbackText: "T3 Code could not start this task.",
          children: [
            Header({ children: "Task did not start" }),
            Section({
              children:
                "T3 Code could not create an isolated worktree. The task was stopped before the agent ran.",
            }),
          ],
        }),
      );
    }
  };

  channel.onMention(({ thread, message }) => handleText(thread, message.text));
  channel.onCommand("t3", ({ thread, text }) => handleText(thread, text));

  return {
    channel,
    notifyCompleted: async (completion: {
      readonly threadId: ThreadId;
      readonly changedFileCount: number;
    }) => {
      const thread = linkedThreads.get(completion.threadId);
      if (!thread) return;
      const task = await input.operations.getTaskStatus(completion.threadId);
      if (!task) return;
      await thread.post(completedCard({ task, changedFileCount: completion.changedFileCount }));
      linkedThreads.delete(completion.threadId);
    },
  };
}

const makeOperations = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);

  const nextId = Effect.fn("T3CodeDiscordChannel.nextId")(function* (prefix: string) {
    const uuid = yield* crypto.randomUUIDv4;
    return `${prefix}-${uuid}`;
  });

  const startTaskEffect = Effect.fn("T3CodeDiscordChannel.startTask")(function* (
    prompt: string,
    config: DiscordChannelSettings,
  ) {
    if (config.projectId === null) {
      return yield* Effect.fail("Discord channel project is not configured");
    }
    const projectOption = yield* projectionSnapshotQuery.getProjectShellById(config.projectId);
    if (Option.isNone(projectOption)) {
      return yield* Effect.fail("Discord channel project was not found");
    }
    const project = projectOption.value;
    if (project.defaultModelSelection === null) {
      return yield* Effect.fail("Discord channel project has no default model");
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const threadId = ThreadId.make(yield* nextId("channel-thread"));
    const suffix = (yield* nextId("branch")).slice(-8);
    const branch = channelBranchName({
      prefix: config.branchPrefix,
      prompt,
      suffix,
    });
    if (branch === config.baseBranch) {
      return yield* Effect.fail("Discord channel branch must differ from its base branch");
    }

    const worktree = yield* gitWorkflow.createWorktree({
      cwd: project.workspaceRoot,
      refName: config.baseBranch,
      baseRefName: config.baseBranch,
      newRefName: branch,
      path: null,
    });
    const title = promptTitle(prompt);
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* nextId("channel-create")),
      threadId,
      projectId: project.id,
      title,
      modelSelection: project.defaultModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: worktree.worktree.refName,
      worktreePath: worktree.worktree.path,
      createdAt: now,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(yield* nextId("channel-turn")),
      threadId,
      message: {
        messageId: MessageId.make(yield* nextId("channel-message")),
        role: "user",
        text: prompt,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    });
    return {
      threadId,
      title,
      branch: worktree.worktree.refName,
      state: "queued" as const,
    };
  });

  const getTaskStatusEffect = Effect.fn("T3CodeDiscordChannel.getTaskStatus")(function* (
    threadId: ThreadId,
  ) {
    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(threadOption)) return null;
    const thread = threadOption.value;
    const state = (() => {
      if (thread.latestTurn?.state === "error" || thread.session?.status === "error") {
        return "failed" as const;
      }
      if (thread.latestTurn?.state === "completed") return "done" as const;
      if (thread.latestTurn?.state === "running" || thread.session?.status === "running") {
        return "running" as const;
      }
      return "queued" as const;
    })();
    return {
      threadId,
      title: thread.title,
      branch: thread.branch ?? "isolated worktree",
      state,
    };
  });

  return {
    startTask: (prompt, config) => runPromise(startTaskEffect(prompt, config)),
    getTaskStatus: (threadId) => runPromise(getTaskStatusEffect(threadId)),
  } satisfies T3CodeChannelOperations;
});

function configFingerprint(config: DiscordChannelSettings): string {
  return [
    config.enabled,
    config.projectId,
    config.baseBranch,
    config.branchPrefix,
    config.applicationId,
    config.guildId,
    config.botToken,
  ].join("\u0000");
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const operations = yield* makeOperations;
    const activeRef = yield* Ref.make<ActiveDiscordChannel | null>(null);

    const stopActive = Effect.fn("T3CodeDiscordChannel.stopActive")(function* () {
      const active = yield* Ref.getAndSet(activeRef, null);
      if (!active) return;
      yield* Effect.tryPromise(() => active.stop()).pipe(Effect.ignoreCause({ log: true }));
    });

    const reconcile = Effect.fn("T3CodeDiscordChannel.reconcile")(function* (
      settings: ServerSettings,
    ) {
      const config = settings.channelIntegrations.discord;
      const fingerprint = configFingerprint(config);
      const active = yield* Ref.get(activeRef);
      if (active?.fingerprint === fingerprint) return;
      yield* stopActive();
      if (!isDiscordChannelConfigured(config)) return;

      const created = createT3CodeChannel({ config, operations });
      const connected = yield* Effect.tryPromise(() => created.channel.ɵruntime.start()).pipe(
        Effect.timeout("15 seconds"),
        Effect.as(true),
        Effect.tapCause((cause) =>
          Effect.logWarning("Discord channel failed to connect", { cause }),
        ),
        Effect.catchCause(() => Effect.succeed(false)),
      );
      if (!connected) {
        yield* Effect.tryPromise(() => created.channel.ɵruntime.stop()).pipe(
          Effect.ignoreCause({ log: true }),
        );
        return;
      }
      yield* Ref.set(activeRef, {
        fingerprint,
        notifyCompleted: created.notifyCompleted,
        stop: () => created.channel.ɵruntime.stop(),
      });
    });

    yield* Effect.addFinalizer(() => stopActive());
    yield* forkParked(
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* settingsService.subscribeChanges;
          yield* reconcile(yield* settingsService.getSettings);
          yield* Stream.runForEach(changes, reconcile);
        }),
      ),
    );
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-diff-completed") return Effect.void;
        return Ref.get(activeRef).pipe(
          Effect.flatMap((active) =>
            active
              ? Effect.tryPromise(() =>
                  active.notifyCompleted({
                    threadId: event.payload.threadId,
                    changedFileCount: event.payload.files.length,
                  }),
                ).pipe(Effect.ignoreCause({ log: true }))
              : Effect.void,
          ),
        );
      }),
    );
  }),
);
