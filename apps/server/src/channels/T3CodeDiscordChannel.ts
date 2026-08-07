import { createChannel, defineChannelCommand } from "@copilotkit/channels-core";
import { discord } from "@copilotkit/channels-discord";
import type { MessageRef, Thread } from "@copilotkit/channels-ui";
import {
  CommandId,
  type DiscordChannelSettings,
  MessageId,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { z } from "zod";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const MAX_TITLE_LENGTH = 72;
const MAX_BRANCH_SLUG_LENGTH = 40;

export interface ChannelTaskStatus {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly branch: string | null;
  readonly threadEnvMode: "local" | "worktree";
  readonly modelSelection: ModelSelection;
  readonly state: "queued" | "running" | "done" | "failed";
}

export interface StartedChannelTask extends ChannelTaskStatus {
  readonly state: "queued";
}

export interface T3CodeChannelOperations {
  readonly startTask: (
    prompt: string,
    config: DiscordChannelSettings,
    modelSelection?: ModelSelection,
  ) => Promise<StartedChannelTask>;
  readonly getTaskStatus: (threadId: ThreadId) => Promise<ChannelTaskStatus | null>;
  readonly listModels: () => Promise<ReadonlyArray<DiscordModelOption>>;
}

interface LinkedConversationState {
  readonly t3ThreadId?: string;
  readonly modelSelection?: ModelSelection;
}

export interface DiscordModelOption {
  readonly value: string;
  readonly label: string;
  readonly selection: ModelSelection;
}

export function discordModelOptions(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<DiscordModelOption> {
  return providers.flatMap((provider) => {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable"
    ) {
      return [];
    }
    return provider.models
      .filter((model) => model.isLegacy !== true)
      .map((model) => ({
        value: `${provider.instanceId}/${model.slug}`,
        label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
        selection: { instanceId: provider.instanceId, model: model.slug },
      }));
  });
}

export function resolveDiscordModel(
  models: ReadonlyArray<DiscordModelOption>,
  value: string,
): DiscordModelOption | undefined {
  return models.find((model) => model.value === value);
}

type ChannelThread = Pick<Thread, "post" | "update"> & {
  readonly state: () => Promise<unknown>;
  readonly setState: (value: unknown) => Promise<void>;
};

interface ActiveDiscordChannel {
  readonly fingerprint: string;
  readonly refreshTask: (input: {
    readonly threadId: ThreadId;
    readonly changedFileCount?: number;
  }) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function isDiscordChannelConfigured(config: DiscordChannelSettings): boolean {
  return (
    config.enabled &&
    config.projectId !== null &&
    (config.threadEnvMode === "local" ||
      (config.baseBranch.trim().length > 0 && config.branchPrefix.trim().length > 0)) &&
    config.applicationId.length > 0 &&
    config.botToken.length > 0
  );
}

class DiscordChannelTaskError extends Schema.TaggedErrorClass<DiscordChannelTaskError>()(
  "DiscordChannelTaskError",
  { message: Schema.String },
) {}

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

function modelLabel(selection: ModelSelection): string {
  return `${selection.instanceId}/${selection.model}`;
}

function readConversationState(value: unknown): LinkedConversationState {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const t3ThreadId = typeof record.t3ThreadId === "string" ? record.t3ThreadId : undefined;
  const candidate = record.modelSelection;
  const modelSelection =
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as Record<string, unknown>).instanceId === "string" &&
    typeof (candidate as Record<string, unknown>).model === "string"
      ? (candidate as ModelSelection)
      : undefined;
  return { ...(t3ThreadId ? { t3ThreadId } : {}), ...(modelSelection ? { modelSelection } : {}) };
}

export function taskStatusText(task: ChannelTaskStatus, changedFileCount?: number): string {
  const heading = (() => {
    switch (task.state) {
      case "queued":
        return "⏳ **T3 Code queued**";
      case "running":
        return "🔄 **T3 Code is working**";
      case "done":
        return "✅ **T3 Code finished**";
      case "failed":
        return "❌ **T3 Code failed**";
    }
  })();
  const target =
    task.threadEnvMode === "worktree"
      ? `Branch: \`${task.branch ?? "worktree"}\``
      : "Target: project checkout";
  const diff =
    task.state === "done" && changedFileCount !== undefined
      ? `\nChanged: ${changedFileCount} ${changedFileCount === 1 ? "file" : "files"}`
      : "";
  return `${heading}\n${task.title}\nModel: \`${modelLabel(task.modelSelection)}\`\n${target}${diff}`;
}

function createT3CodeChannel(input: {
  readonly config: DiscordChannelSettings;
  readonly operations: T3CodeChannelOperations;
  readonly models: ReadonlyArray<DiscordModelOption>;
}) {
  const linkedTasks = new Map<
    string,
    {
      readonly thread: Pick<Thread, "post" | "update">;
      messageRef: MessageRef;
      changedFileCount?: number;
    }
  >();
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
    if (!status) {
      await thread.post("That T3 Code task no longer exists.");
      return;
    }
    const linked = linkedTasks.get(threadId);
    if (linked) {
      linked.messageRef = await linked.thread.update(
        linked.messageRef,
        taskStatusText(status, linked.changedFileCount),
      );
      return;
    }
    await thread.post(taskStatusText(status));
  };

  const handleText = async (thread: ChannelThread, rawText: string) => {
    const text = cleanDiscordPrompt(rawText);
    const state = readConversationState(await thread.state());
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
        await postStatus(thread, current.threadId);
        return;
      }
    }

    try {
      const task = await input.operations.startTask(text, input.config, state.modelSelection);
      await thread.setState({
        ...state,
        t3ThreadId: task.threadId,
      } satisfies LinkedConversationState);
      const messageRef = await thread.post(taskStatusText(task));
      linkedTasks.set(task.threadId, { thread, messageRef });
      await postStatus(thread, task.threadId);
    } catch {
      await thread.post(
        input.config.threadEnvMode === "worktree"
          ? "❌ **T3 Code could not start**\nThe isolated worktree could not be created, so the agent did not run."
          : "❌ **T3 Code could not start**\nCheck the project and provider configuration.",
      );
    }
  };

  channel.onMention(({ thread, message }) => handleText(thread, message.text));
  channel.onCommand(
    defineChannelCommand({
      name: "t3",
      description: "Run a coding task in T3 Code with the selected model.",
      options: z.object({
        prompt: z.string().min(1).describe("The coding task for T3 Code"),
      }),
      handler: ({ thread, text, options }) => handleText(thread, options.prompt ?? text),
    }),
  );
  channel.onCommand(
    defineChannelCommand({
      name: "status",
      description: "Show the status of the T3 Code task linked to this channel.",
      handler: ({ thread }) => handleText(thread, "status"),
    }),
  );

  const selectableModels = input.models.slice(0, 25);
  const modelValues = selectableModels.map(({ value }) => value);
  const modelSchema =
    modelValues.length > 0 ? z.enum(modelValues as [string, ...string[]]) : z.string().min(1);
  channel.onCommand(
    defineChannelCommand({
      name: "model",
      description: "Choose the model used by future T3 Code tasks in this channel.",
      options: z.object({
        model: modelSchema.describe("Provider and model"),
      }),
      async handler({ thread, options }) {
        const selected = resolveDiscordModel(selectableModels, options.model);
        if (!selected) {
          await thread.post(
            "That model is not currently available. Run `/models` to see the list.",
          );
          return;
        }
        const state = readConversationState(await thread.state());
        await thread.setState({
          ...state,
          modelSelection: selected.selection,
        } satisfies LinkedConversationState);
        await thread.post(
          `Future T3 Code tasks in this channel will use **${selected.label}** (\`${selected.value}\`).`,
        );
      },
    }),
  );
  channel.onCommand(
    defineChannelCommand({
      name: "models",
      description: "List models available to T3 Code and show the current selection.",
      async handler({ thread }) {
        const state = readConversationState(await thread.state());
        const current = state.modelSelection ? modelLabel(state.modelSelection) : "project default";
        const list = selectableModels
          .map(({ value, label }) => `• \`${value}\` — ${label}`)
          .join("\n");
        await thread.post(
          `**Current model:** ${current === "project default" ? current : `\`${current}\``}\n\n${list || "No runnable models are currently available."}`,
        );
      },
    }),
  );

  return {
    channel,
    refreshTask: async (completion: {
      readonly threadId: ThreadId;
      readonly changedFileCount?: number;
    }) => {
      const linked = linkedTasks.get(completion.threadId);
      if (!linked) return;
      if (completion.changedFileCount !== undefined) {
        linked.changedFileCount = completion.changedFileCount;
      }
      const task = await input.operations.getTaskStatus(completion.threadId);
      if (!task) return;
      linked.messageRef = await linked.thread.update(
        linked.messageRef,
        taskStatusText(task, linked.changedFileCount),
      );
    },
  };
}

const makeOperations = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);

  const nextId = Effect.fn("T3CodeDiscordChannel.nextId")(function* (prefix: string) {
    const uuid = yield* crypto.randomUUIDv4;
    return `${prefix}-${uuid}`;
  });

  const createTaskWorktree = Effect.fn("T3CodeDiscordChannel.createTaskWorktree")(function* (
    prompt: string,
    config: DiscordChannelSettings,
    workspaceRoot: string,
  ) {
    const suffix = (yield* nextId("branch")).slice(-8);
    const branch = channelBranchName({
      prefix: config.branchPrefix,
      prompt,
      suffix,
    });
    if (branch === config.baseBranch) {
      return yield* new DiscordChannelTaskError({
        message: "Discord channel branch must differ from its base branch",
      });
    }
    return yield* gitWorkflow.createWorktree({
      cwd: workspaceRoot,
      refName: config.baseBranch,
      baseRefName: config.baseBranch,
      newRefName: branch,
      path: null,
    });
  });

  const startTaskEffect = Effect.fn("T3CodeDiscordChannel.startTask")(function* (
    prompt: string,
    config: DiscordChannelSettings,
    requestedModelSelection?: ModelSelection,
  ) {
    if (config.projectId === null) {
      return yield* new DiscordChannelTaskError({
        message: "Discord channel project is not configured",
      });
    }
    const projectOption = yield* projectionSnapshotQuery.getProjectShellById(config.projectId);
    if (Option.isNone(projectOption)) {
      return yield* new DiscordChannelTaskError({
        message: "Discord channel project was not found",
      });
    }
    const project = projectOption.value;
    const modelSelection = requestedModelSelection ?? project.defaultModelSelection;
    if (modelSelection === null) {
      return yield* new DiscordChannelTaskError({
        message: "Discord channel project has no default model",
      });
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const threadId = ThreadId.make(yield* nextId("channel-thread"));
    const worktree =
      config.threadEnvMode === "worktree"
        ? yield* createTaskWorktree(prompt, config, project.workspaceRoot)
        : null;
    const title = promptTitle(prompt);
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* nextId("channel-create")),
      threadId,
      projectId: project.id,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: worktree?.worktree.refName ?? null,
      worktreePath: worktree?.worktree.path ?? null,
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
      branch: worktree?.worktree.refName ?? null,
      threadEnvMode: config.threadEnvMode,
      modelSelection,
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
    const threadEnvMode = thread.worktreePath === null ? ("local" as const) : ("worktree" as const);
    return {
      threadId,
      title: thread.title,
      branch: thread.branch,
      threadEnvMode,
      modelSelection: thread.modelSelection,
      state,
    };
  });

  return {
    startTask: (prompt, config, modelSelection) =>
      runPromise(startTaskEffect(prompt, config, modelSelection)),
    getTaskStatus: (threadId) => runPromise(getTaskStatusEffect(threadId)),
    listModels: () =>
      runPromise(providerRegistry.getProviders.pipe(Effect.map(discordModelOptions))),
  } satisfies T3CodeChannelOperations;
});

function configFingerprint(config: DiscordChannelSettings): string {
  return [
    config.enabled,
    config.projectId,
    config.threadEnvMode,
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

      const models = yield* Effect.tryPromise(() => operations.listModels()).pipe(
        Effect.orElseSucceed(() => []),
      );
      const created = createT3CodeChannel({ config, operations, models });
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
        refreshTask: created.refreshTask,
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
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.session-set" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return Ref.get(activeRef).pipe(
          Effect.flatMap((active) =>
            active
              ? Effect.tryPromise(() =>
                  active.refreshTask({
                    threadId: event.payload.threadId,
                    ...(event.type === "thread.turn-diff-completed"
                      ? { changedFileCount: event.payload.files.length }
                      : {}),
                  }),
                ).pipe(Effect.ignoreCause({ log: true }))
              : Effect.void,
          ),
        );
      }),
    );
  }),
);
