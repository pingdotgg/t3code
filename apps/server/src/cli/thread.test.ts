import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { DEFAULT_THREAD_TITLE } from "../orchestration/Layers/ProviderCommandReactor.ts";
import {
  buildThreadLaunchCommands,
  resolveThreadNewTitle,
  ThreadTitleEmptyError,
} from "./thread.ts";

const isClientOrchestrationCommand = Schema.is(ClientOrchestrationCommand);

const testModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

const testLaunchInput = {
  threadId: ThreadId.make("11111111-1111-4111-8111-111111111111"),
  messageId: MessageId.make("22222222-2222-4222-8222-222222222222"),
  createCommandId: CommandId.make("33333333-3333-4333-8333-333333333333"),
  turnStartCommandId: CommandId.make("44444444-4444-4444-8444-444444444444"),
  createdAt: "2026-08-22T12:00:00.000Z",
  projectId: ProjectId.make("55555555-5555-4555-8555-555555555555"),
  title: DEFAULT_THREAD_TITLE,
  prompt: "Fix the flaky login test",
  modelSelection: testModelSelection,
  runtimeMode: "full-access",
} as const;

it.effect("falls back to the server default title so the server generates one", () =>
  Effect.gen(function* () {
    const title = yield* resolveThreadNewTitle(undefined);
    assert.strictEqual(title, DEFAULT_THREAD_TITLE);
  }),
);

it.effect("keeps an explicit title trimmed", () =>
  Effect.gen(function* () {
    const title = yield* resolveThreadNewTitle("  Release checklist  ");
    assert.strictEqual(title, "Release checklist");
  }),
);

it.effect("rejects a whitespace-only title", () =>
  Effect.gen(function* () {
    const error = yield* resolveThreadNewTitle("   ").pipe(Effect.flip);
    assert.instanceOf(error, ThreadTitleEmptyError);
    assert.strictEqual(error.title, "   ");
  }),
);

it("builds a thread.create followed by a thread.turn.start for the same thread", () => {
  const commands = buildThreadLaunchCommands(testLaunchInput);

  assert.strictEqual(commands.create.type, "thread.create");
  assert.strictEqual(commands.turnStart.type, "thread.turn.start");
  assert.strictEqual(commands.create.threadId, testLaunchInput.threadId);
  assert.strictEqual(commands.turnStart.threadId, testLaunchInput.threadId);
  assert.notStrictEqual(commands.create.commandId, commands.turnStart.commandId);
  assert.strictEqual(commands.create.projectId, testLaunchInput.projectId);
  assert.strictEqual(commands.turnStart.message.text, testLaunchInput.prompt);
  assert.deepEqual(commands.turnStart.message.attachments, []);
  assert.strictEqual(commands.create.modelSelection, testLaunchInput.modelSelection);
  assert.strictEqual(commands.turnStart.modelSelection, testLaunchInput.modelSelection);
  assert.strictEqual(commands.create.runtimeMode, "full-access");
  assert.strictEqual(commands.turnStart.runtimeMode, "full-access");
});

it("creates the thread in the project checkout without a worktree or bootstrap", () => {
  const commands = buildThreadLaunchCommands(testLaunchInput);

  assert.isNull(commands.create.branch);
  assert.isNull(commands.create.worktreePath);
  // The HTTP dispatch route has no bootstrap handling; the turn start must
  // not carry one.
  assert.notProperty(commands.turnStart, "bootstrap");
});

it("builds commands that satisfy the client orchestration command schema", () => {
  const commands = buildThreadLaunchCommands(testLaunchInput);

  assert.isTrue(isClientOrchestrationCommand(commands.create));
  assert.isTrue(isClientOrchestrationCommand(commands.turnStart));
});
