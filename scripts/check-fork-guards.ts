#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - hashes test bodies with node:crypto.
// Syncs have dropped or loosened the fork's tests for its fixes. Each guard pins one test's
// title and body hash, so changing it fails here with the fix it protects named.
// --update re-pins hashes after a reviewed change; --base <ref> lists guarded sources changed.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Command, Flag } from "effect/cli";

const GUARDS_PATH = "scripts/fork-guards.json";
const UPDATE_COMMAND = "node scripts/check-fork-guards.ts --update";

const ForkGuard = Schema.Struct({
  fix: Schema.String,
  protects: Schema.String,
  test: Schema.String,
  title: Schema.String,
  sha256: Schema.String,
  sources: Schema.Array(Schema.String),
});
export type ForkGuard = typeof ForkGuard.Type;

const Guards = Schema.fromJsonString(Schema.Array(ForkGuard), { space: 2 });
const decodeGuards = Schema.decodeEffect(Guards);
const encodeGuards = Schema.encodeEffect(Guards);

const TEST_CALL = /\b(?:it|test)(?:\.\w+)*\(/g;

/** The source of the test titled `title`, from its `it(` line through its closing `);`. */
export function extractTest(source: string, title: string): string | undefined {
  const titleAt = source.indexOf(JSON.stringify(title));
  if (titleAt === -1) return undefined;
  let callAt = -1;
  for (const match of source.slice(0, titleAt).matchAll(TEST_CALL)) callAt = match.index;
  if (callAt === -1) return undefined;
  const lineStart = source.lastIndexOf("\n", callAt) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart))![0];
  const end = new RegExp(`\\n${indent}\\}?\\);?[ \\t]*(?:\\n|$)`, "g");
  end.lastIndex = titleAt;
  const closing = end.exec(source);
  return closing === null ? undefined : source.slice(lineStart, closing.index + closing[0].length);
}

/** Whitespace-insensitive, so reformatting a guard does not trip it. */
export function hashTest(body: string): string {
  return NodeCrypto.createHash("sha256").update(body.replace(/\s+/g, "")).digest("hex");
}

/** One problem per guard whose test is gone or no longer matches its pinned body. */
export function findGuardProblems(
  guards: ReadonlyArray<ForkGuard>,
  readTest: (file: string) => string | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  for (const guard of guards) {
    const where = `fork fix ${guard.fix} (${guard.protects})`;
    const source = readTest(guard.test);
    const body = source === undefined ? undefined : extractTest(source, guard.title);
    if (body === undefined) {
      problems.push(
        `${guard.test}: the test "${guard.title}" is gone. It guards ${where}. Restore it, or move it and update ${GUARDS_PATH}.`,
      );
    } else if (hashTest(body) !== guard.sha256) {
      problems.push(
        `${guard.test}: the test "${guard.title}" changed. It guards ${where}. Check it still fails without that fix, then run \`${UPDATE_COMMAND}\` and say why in the PR.`,
      );
    }
  }
  return problems;
}

class ForkGuardError extends Schema.TaggedError<ForkGuardError>()("ForkGuardError", {
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return [
      "Fork regression tests were removed or changed:",
      ...this.problems.map((problem) => `  - ${problem}`),
    ].join("\n");
  }
}

const command = Command.make(
  "check-fork-guards",
  {
    update: Flag.Boolean("update").pipe(
      Flag.withDescription("Re-pin every guard's hash to its current test body."),
      Flag.withDefault(false),
    ),
    base: Flag.String("base").pipe(
      Flag.withDescription("Git ref before the sync; lists guarded sources the sync changed."),
      Flag.optional,
    ),
  },
  Effect.fn("checkForkGuards")(function* ({ update, base }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const guardsFile = path.join(repoRoot, GUARDS_PATH);
    const guards = yield* decodeGuards(yield* fs.readFileString(guardsFile));
    const tests = new Map<string, string | undefined>();
    for (const guard of guards) {
      if (tests.has(guard.test)) continue;
      const file = path.join(repoRoot, guard.test);
      tests.set(guard.test, (yield* fs.exists(file)) ? yield* fs.readFileString(file) : undefined);
    }
    const readTest = (file: string) => tests.get(file);

    if (Option.isSome(base)) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const sources = [...new Set(guards.flatMap((guard) => guard.sources))];
      const changed = new Set(
        (yield* spawner.string(
          ChildProcess.make("git", ["diff", "--name-only", base.value, "--", ...sources], {
            cwd: repoRoot,
          }),
        ))
          .split("\n")
          .filter((line) => line.length > 0),
      );
      const touchedByFix = new Map<string, Set<string>>();
      for (const guard of guards) {
        for (const source of guard.sources.filter((source) => changed.has(source))) {
          const key = `${guard.fix} (${guard.protects})`;
          touchedByFix.set(key, (touchedByFix.get(key) ?? new Set()).add(source));
        }
      }
      for (const [fix, touched] of touchedByFix) {
        yield* Effect.log(
          `Since ${base.value}, ${[...touched].join(", ")} changed: re-check fork fix ${fix}.`,
        );
      }
    }

    if (update) {
      const missing = guards.filter(
        (guard) => extractTest(readTest(guard.test) ?? "", guard.title) === undefined,
      );
      if (missing.length > 0) {
        return yield* new ForkGuardError({ problems: findGuardProblems(missing, readTest) });
      }
      const updated = guards.map((guard) => ({
        ...guard,
        sha256: hashTest(extractTest(readTest(guard.test)!, guard.title)!),
      }));
      yield* fs.writeFileString(guardsFile, `${yield* encodeGuards(updated)}\n`);
      return yield* Effect.log(`Pinned ${updated.length} fork guards.`);
    }

    const problems = findGuardProblems(guards, readTest);
    if (problems.length > 0) return yield* new ForkGuardError({ problems });
    yield* Effect.log(`All ${guards.length} fork guard tests are present and unchanged.`);
  }),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
