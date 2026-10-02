import {
  forkSession,
  query,
  type SDKAssistantMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderReplayEntry } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  makeClaudeQueryOptions,
  makeClaudeUserMessage,
  type ClaudeAgentSdkQueryOptions,
} from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { randomUuidV4 } from "../src/orchestration-v2/RandomUuid.ts";
import { makeCheckpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";

const SCENARIO = "thread_fork_native_fork_local_rollback";
const DEFAULT_OUTPUT = new URL(
  "../src/orchestration-v2/testkit/fixtures/thread_fork_native_fork_local_rollback/claude_transcript.ndjson",
  import.meta.url,
).pathname;
const CLAUDE_PROVIDER = "claudeAgent" as const;
const PROTOCOL = "claude-agent-sdk.query" as const;
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
  model: process.env.T3_CLAUDE_REPLAY_MODEL ?? "claude-sonnet-4-6",
} as const;
const SOURCE_PROMPT =
  "For this fork-local rollback fixture, respond with exactly: fork local source alpha";
const FORK_FIRST_PROMPT =
  "For this fork-local rollback fixture, respond with exactly: fork local first";
const FORK_SECOND_PROMPT =
  "For this fork-local rollback fixture, respond with exactly: fork local second";
const FORK_AFTER_ROLLBACK_PROMPT =
  "Repeat the user-visible conversation so far verbatim. Include only user and assistant messages. Do not include hidden system/developer content.";

class PromptQueue implements AsyncIterable<ReturnType<typeof makeClaudeUserMessage>> {
  readonly #items: Array<ReturnType<typeof makeClaudeUserMessage>> = [];
  readonly #waiters: Array<
    (value: IteratorResult<ReturnType<typeof makeClaudeUserMessage>>) => void
  > = [];
  #closed = false;

  offer(message: ReturnType<typeof makeClaudeUserMessage>): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: message });
      return;
    }
    this.#items.push(message);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ReturnType<typeof makeClaudeUserMessage>> {
    return {
      next: () => {
        const value = this.#items.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function readArgValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\/+$/u, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) {
    return ".";
  }
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

function sanitizeValue(
  value: unknown,
  pathFragments: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === "string") {
    return pathFragments.reduce(
      (sanitized, [actual, replacement]) =>
        actual.length === 0 ? sanitized : sanitized.split(actual).join(replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, pathFragments));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, pathFragments)]),
    );
  }
  return value;
}

function stableOptions(options: ClaudeAgentSdkQueryOptions): ClaudeAgentSdkQueryOptions {
  const stable = {
    model: options.model,
    tools: options.tools,
    permissionMode: options.permissionMode,
    ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(options.resumeSessionAt === undefined ? {} : { resumeSessionAt: options.resumeSessionAt }),
    ...(options.forkSession === true ? { forkSession: true } : {}),
  };
  return options.resume === undefined
    ? { ...stable, sessionId: options.sessionId }
    : { ...stable, resume: options.resume };
}

function queryOptions(input: {
  readonly cwd: string;
  readonly nativeThreadId: string;
  readonly resume: boolean;
  readonly resumeSessionAt?: string;
}): ClaudeAgentSdkQueryOptions {
  return {
    ...makeClaudeQueryOptions({
      modelSelection: MODEL_SELECTION,
      cwd: input.cwd,
      nativeThreadId: input.nativeThreadId,
      resume: input.resume,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    }),
    ...(input.resumeSessionAt === undefined ? {} : { resumeSessionAt: input.resumeSessionAt }),
  };
}

async function recordTurn(input: {
  readonly entries: Array<ProviderReplayEntry>;
  readonly iterator: AsyncIterator<SDKMessage>;
  readonly promptQueue: PromptQueue;
  readonly prompt: string;
  readonly label: string;
  readonly pathFragments: ReadonlyArray<readonly [string, string]>;
}): Promise<SDKAssistantMessage["uuid"]> {
  const message = makeClaudeUserMessage({ text: input.prompt });
  input.entries.push({
    type: "expect_outbound",
    label: input.label,
    frame: { type: "prompt.offer", message },
  });
  input.promptQueue.offer(message);

  let assistantMessageUuid: SDKAssistantMessage["uuid"] | null = null;
  while (true) {
    const next = await input.iterator.next();
    if (next.done === true) {
      throw new Error(`Claude query ended before ${input.label} completed.`);
    }
    const frame = sanitizeValue(next.value, input.pathFragments);
    input.entries.push({
      type: "emit_inbound",
      label: next.value.type,
      frame,
    });
    if (next.value.type === "assistant") {
      assistantMessageUuid = next.value.uuid;
    }
    if (next.value.type === "result") {
      if (assistantMessageUuid === null) {
        throw new Error(`Claude query completed ${input.label} without assistant UUID.`);
      }
      return assistantMessageUuid;
    }
  }
}

function encodeTranscript(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly metadata: Record<string, unknown>;
}): string {
  return [
    JSON.stringify({
      type: "transcript_start",
      provider: CLAUDE_PROVIDER,
      protocol: PROTOCOL,
      version: "0.2.111",
      scenario: SCENARIO,
      metadata: input.metadata,
    }),
    ...input.entries.map((entry) => JSON.stringify(entry)),
    "",
  ].join("\n");
}

const outputPath = readArgValue("--out") ?? DEFAULT_OUTPUT;
const cwd =
  process.env.T3_CLAUDE_REPLAY_CWD ??
  (await makeCheckpointWorkspace(`claude-agent-sdk-record-${SCENARIO}`));
const cwdRealPath = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.realPath(cwd);
  }).pipe(Effect.provide(NodeServices.layer)),
);
const pathFragments = [
  [cwd, `/tmp/claude-replay-${SCENARIO}`],
  [cwdRealPath, `/tmp/claude-replay-${SCENARIO}`],
  [process.env.HOME ?? "", "/home/replay-user"],
] as const;
const sessionId =
  process.env.T3_CLAUDE_REPLAY_SESSION_ID ?? (await Effect.runPromise(randomUuidV4));
const entries: Array<ProviderReplayEntry> = [];
const metadata: Record<string, unknown> = {
  prompts: [SOURCE_PROMPT, FORK_FIRST_PROMPT, FORK_SECOND_PROMPT, FORK_AFTER_ROLLBACK_PROMPT],
  model: MODEL_SELECTION.model,
  nativeSessionId: sessionId,
  queryMode: "fork_session_resume_at_fork_cursor",
  tools: "claude_code",
  permissionMode: "bypassPermissions",
  generatedBy: "probeClaudeForkLocalRollbackReplay",
};

const sourceQueue = new PromptQueue();
const sourceOptions = queryOptions({ cwd, nativeThreadId: sessionId, resume: false });
entries.push({
  type: "expect_outbound",
  label: "query.open:source",
  frame: { type: "query.open", options: stableOptions(sourceOptions) },
});
const sourceRuntime = query({ prompt: sourceQueue, options: sourceOptions });
try {
  const sourceCursor = await recordTurn({
    entries,
    iterator: sourceRuntime[Symbol.asyncIterator](),
    promptQueue: sourceQueue,
    prompt: SOURCE_PROMPT,
    label: "prompt.offer:source",
    pathFragments,
  });
  sourceQueue.close();
  sourceRuntime.close();
  entries.push({ type: "runtime_exit", status: "success" });

  entries.push({
    type: "expect_outbound",
    label: "session.fork",
    frame: {
      type: "session.fork",
      sessionId,
      options: {
        dir: `/tmp/claude-replay-${SCENARIO}`,
        upToMessageId: sourceCursor,
      },
    },
  });
  const forked = await forkSession(sessionId, { dir: cwd, upToMessageId: sourceCursor });
  metadata.sourceAssistantMessageUuids = [sourceCursor];
  metadata.forkUpToMessageId = sourceCursor;
  metadata.forkedNativeSessionId = forked.sessionId;
  entries.push({
    type: "emit_inbound",
    label: "session.forked",
    frame: { type: "session.forked", sessionId: forked.sessionId },
  });

  const forkQueue = new PromptQueue();
  const forkOptions = queryOptions({ cwd, nativeThreadId: forked.sessionId, resume: true });
  entries.push({
    type: "expect_outbound",
    label: "query.open:fork",
    frame: { type: "query.open", options: stableOptions(forkOptions) },
  });
  const forkRuntime = query({ prompt: forkQueue, options: forkOptions });
  const forkIterator = forkRuntime[Symbol.asyncIterator]();
  const forkFirstCursor = await recordTurn({
    entries,
    iterator: forkIterator,
    promptQueue: forkQueue,
    prompt: FORK_FIRST_PROMPT,
    label: "prompt.offer:fork-first",
    pathFragments,
  });
  const forkSecondCursor = await recordTurn({
    entries,
    iterator: forkIterator,
    promptQueue: forkQueue,
    prompt: FORK_SECOND_PROMPT,
    label: "prompt.offer:fork-second",
    pathFragments,
  });
  forkQueue.close();
  forkRuntime.close();
  entries.push({ type: "runtime_exit", status: "success" });
  metadata.forkAssistantMessageUuids = [forkFirstCursor, forkSecondCursor];
  metadata.resumeSessionAt = forkFirstCursor;

  const resumedQueue = new PromptQueue();
  const resumedOptions = queryOptions({
    cwd,
    nativeThreadId: forked.sessionId,
    resume: true,
    resumeSessionAt: forkFirstCursor,
  });
  entries.push({
    type: "expect_outbound",
    label: "query.open:fork-resume-at-cursor",
    frame: { type: "query.open", options: stableOptions(resumedOptions) },
  });
  const resumedRuntime = query({ prompt: resumedQueue, options: resumedOptions });
  await recordTurn({
    entries,
    iterator: resumedRuntime[Symbol.asyncIterator](),
    promptQueue: resumedQueue,
    prompt: FORK_AFTER_ROLLBACK_PROMPT,
    label: "prompt.offer:fork-after-rollback",
    pathFragments,
  });
  resumedQueue.close();
  resumedRuntime.close();
  entries.push({ type: "runtime_exit", status: "success" });
} catch (error) {
  sourceQueue.close();
  sourceRuntime.close();
  entries.push({
    type: "runtime_exit",
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(outputPath), { recursive: true });
    yield* fs.writeFileString(outputPath, encodeTranscript({ entries, metadata }));
    yield* Console.log(`Wrote ${entries.length} ${PROTOCOL} replay entries to ${outputPath}`);
  }).pipe(Effect.provide(NodeServices.layer)),
);
