import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { folderChangeNote, latestCountedRunFolder } from "./FolderChangeNotice.ts";

function run(ordinal: number, extra: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status: "completed",
    completedAt: DateTime.makeUnsafe(ordinal * 1000),
    cwd: `/folder/${ordinal}`,
    ...extra,
  } as OrchestrationV2Run;
}

const codexThreadId = ProviderThreadId.make("provider-thread:codex");
const opencodeThreadId = ProviderThreadId.make("provider-thread:opencode");

type Runs = ReadonlyArray<OrchestrationV2Run>;
const latest = (
  runs: Runs,
  options: Partial<Record<"accepted" | "compactions" | "goals" | "onOpencode", Runs>> = {},
) =>
  latestCountedRunFolder({
    runs,
    attempts: [...runs, ...(options.accepted ?? [])].map((source) => ({
      id: source.activeAttemptId!,
      runId: source.id,
      providerThreadId: options.onOpencode?.includes(source) ? opencodeThreadId : codexThreadId,
    })),
    providerTurns: (options.accepted ?? runs).map((source) => ({
      runAttemptId: source.activeAttemptId!,
    })),
    providerThreads: [
      { id: codexThreadId, driver: ProviderDriverKind.make("codex") },
      { id: opencodeThreadId, driver: ProviderDriverKind.make("opencode") },
    ],
    messages: runs.map((source) => ({
      id: source.userMessageId,
      role: "user",
      text: options.compactions?.includes(source)
        ? "/compact"
        : options.goals?.includes(source)
          ? "/goal Ship it"
          : "Continue",
      attachments: [],
    })),
  });

it("takes the folder of the latest run the provider accepted that still stands", () => {
  const r1 = run(1);
  const r2 = run(2);
  const starting = run(3, { completedAt: null });
  assert.strictEqual(latest([]), undefined);
  assert.strictEqual(latest([r1], { accepted: [] }), undefined);
  assert.strictEqual(latest([r1, r2, run(3, { status: "rolled_back" })]), "/folder/2");
  assert.strictEqual(latest([r1, run(2, { status: "interrupted" })]), "/folder/2");
  assert.strictEqual(latest([r1, r2], { accepted: [r1] }), "/folder/1");
  assert.strictEqual(latest([r1, run(2, { cwd: undefined })]), "/folder/1");
  assert.strictEqual(latest([r1, run(2, { restartContinuationOfRunId: r1.id })]), "/folder/1");
  assert.strictEqual(latest([r1, r2], { compactions: [r2] }), "/folder/1");
  assert.strictEqual(latest([run(1, { completedAt: DateTime.makeUnsafe(3000) }), r2]), "/folder/1");
  const goal = { accepted: [r1, r2], goals: [r2] };
  assert.strictEqual(latest([r1, r2, starting], { ...goal, onOpencode: [r1, r2] }), "/folder/2");
  assert.strictEqual(latest([r1, r2, starting], { ...goal, onOpencode: [starting] }), "/folder/1");
});

it("counts a run the provider accepted on an attempt a steer later replaced", () => {
  const steered = run(1, { activeAttemptId: RunAttemptId.make("attempt:1:steer") });
  assert.strictEqual(latest([steered], { accepted: [run(1)] }), "/folder/1");
});

it.effect(
  "compares folders after resolving symbolic links, a missing one by its recorded path",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-change-" });
      const folder = path.join(root, "folder");
      const other = path.join(root, "other");
      const link = path.join(root, "link");
      const removed = path.join(root, "removed");
      yield* fileSystem.makeDirectory(folder);
      yield* fileSystem.makeDirectory(other);
      yield* fileSystem.symlink(folder, link);
      const changed = (from: string, to: string) =>
        `The working folder changed from ${JSON.stringify(from)} to ${JSON.stringify(to)}.`;
      for (const [previous, cwd, note] of [
        [undefined, folder, ""],
        [folder, link, ""],
        [folder, other, changed(folder, other)],
        [removed, folder, changed(removed, folder)],
        [removed, removed, ""],
        [
          "/tmp/a\nb",
          "/tmp/c\u2028d",
          'The working folder changed from "/tmp/a\\nb" to "/tmp/c\\u2028d".',
        ],
      ] as const) {
        assert.strictEqual(yield* folderChangeNote(fileSystem, previous, cwd), note);
      }
      const denied = FileSystem.makeNoop({
        realPath: (target) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: target,
            }),
          ),
      });
      assert.strictEqual(yield* folderChangeNote(denied, "/a", "/a"), "");
      const error = yield* Effect.flip(folderChangeNote(denied, "/a", "/w"));
      assert.strictEqual(error.reason._tag, "PermissionDenied");
      const deniedPrevious = FileSystem.makeNoop({
        realPath: (target) => (target === "/a" ? denied.realPath(target) : Effect.succeed(target)),
      });
      assert.strictEqual(yield* folderChangeNote(deniedPrevious, "/a", "/w"), changed("/a", "/w"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
