// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";

import { OnePasswordAccount } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const account = OnePasswordAccount.make("my.1password.com");

type OpResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
  readonly missing?: boolean;
};

function fakeOp(answer: (args: ReadonlyArray<string>) => OpResult) {
  const invocations: Array<ReadonlyArray<string>> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
          invocations.push(args);
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args);
          if (result.missing) {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                pathOrDescriptor: "op",
              }),
            );
          }
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: result.hang
                ? Effect.never
                : Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(encoder.encode(result.stdout ?? "")),
              stderr: Stream.make(encoder.encode(result.stderr ?? "")),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }),
      ),
    ),
    NodeFileSystem.layer,
    NodeCrypto.layer,
  );
  return { layer, invocations, spawned };
}

// Answers `op inject` by substituting each `{{ reference }}` in the template file it was handed.
const injectFrom =
  (secrets: Readonly<Record<string, string>>) =>
  (args: ReadonlyArray<string>): OpResult => {
    const template = NodeFS.readFileSync(args[args.indexOf("-i") + 1]!, "utf8");
    return { stdout: template.replace(/\{\{ (\S+) \}\}/g, (_, reference) => secrets[reference]!) };
  };

describe("1Password driver", () => {
  it.effect("reads one reference from the account", () => {
    const op = fakeOp(() => ({ stdout: "sk-live" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        "sk-live",
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "read",
          "--account=my.1password.com",
          "--no-newline",
          "op://Private/OpenAI/credential",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a failed reference as undefined", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] account is locked" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        undefined,
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads every reference in a single call", () => {
    const op = fakeOp(
      injectFrom({
        "op://Private/OpenAI/credential": "sk-a",
        "op://Private/Anthropic/key": " sk-b\n",
      }),
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Anthropic/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", " sk-b\n"]);
      assert.strictEqual(op.invocations.length, 1);
      assert.deepStrictEqual(op.invocations[0]?.slice(0, 3), [
        "--cache=false",
        "inject",
        "--account=my.1password.com",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("falls back to one read at a time when the batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, stderr: '[ERROR] could not resolve "op://Private/Gone/key"' }
        : args.at(-1) === "op://Private/Gone/key"
          ? { code: 1, stderr: "[ERROR] item not found" }
          : { stdout: "sk-a" },
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Gone/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", undefined]);
      assert.strictEqual(op.invocations.length, 3);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("does not read one at a time after the batch times out", () => {
    const op = fakeOp(() => ({ hang: true }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(op.spawned);
      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual(yield* Fiber.join(reading), [undefined, undefined]);
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });
});

const listChoices = (field: string) => driver.listConfigChoices?.(field) ?? Effect.succeed([]);

describe("1Password listConfigChoices", () => {
  it.effect("lists each account by a value `op --account` accepts unambiguously", () => {
    const op = fakeOp(() => ({
      stdout: JSON.stringify([
        { url: "https://acme.1password.com", email: "me@acme.example", user_uuid: "U1" },
        { url: "my.1password.com", email: "me@example.com", user_uuid: "U2" },
        { url: "my.1password.com", email: "family@example.com", user_uuid: "U3" },
      ]),
    }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* listChoices("account"), [
        {
          value: "acme.1password.com",
          label: "acme.1password.com",
          description: "me@acme.example",
        },
        { value: "U2", label: "my.1password.com", description: "me@example.com" },
        { value: "U3", label: "my.1password.com", description: "family@example.com" },
      ]);
      assert.deepStrictEqual(op.invocations, [
        ["--cache=false", "account", "list", "--format", "json"],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("lists no accounts when `op` cannot answer", () =>
    Effect.forEach(
      [
        { missing: true },
        { code: 1, stderr: "not configured" },
        { stdout: "not json" },
        { hang: true },
      ],
      (answer: OpResult) => {
        const op = fakeOp(() => answer);
        return Effect.gen(function* () {
          const listing = yield* listChoices("account").pipe(Effect.forkChild);
          yield* Deferred.await(op.spawned);
          yield* TestClock.adjust("1 minute");
          assert.deepStrictEqual(yield* Fiber.join(listing), []);
        }).pipe(Effect.provide(op.layer));
      },
      { discard: true },
    ),
  );

  it.effect("has no choices for another field and does not spawn `op`", () => {
    const op = fakeOp(() => ({ stdout: "[]" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* listChoices("vault"), []);
      assert.deepStrictEqual(op.invocations, []);
    }).pipe(Effect.provide(op.layer));
  });
});
