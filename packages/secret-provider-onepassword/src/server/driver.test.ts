// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";

import type { SecretProviderLoginsError } from "@t3tools/secret-provider-core/server/driver";

import { OnePasswordAccount } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const account = OnePasswordAccount.make("my.1password.com");

type OpResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
  readonly delay?: Duration.Input;
};

function fakeOp(answer: (args: ReadonlyArray<string>) => OpResult) {
  const invocations: Array<ReadonlyArray<string>> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
          invocations.push(args);
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: result.hang
              ? Effect.never
              : Effect.sleep(result.delay ?? 0).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(result.code ?? 0)),
                ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
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

  it.effect("gives up within the read timeout when a slow batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, delay: "40 seconds" }
        : { stdout: "sk-a", delay: "40 seconds" },
    );
    // Keeps the temp template off real disk I/O so the virtual clock alone drives the read.
    const templateFile = FileSystem.layerNoop({
      makeTempFileScoped: () => Effect.succeed("/template"),
      writeFileString: () => Effect.void,
    });
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.andThen(Clock.currentTimeMillis), Effect.forkChild);
      yield* TestClock.adjust("5 minutes");

      assert.isAtMost(yield* Fiber.join(reading), 45_000);
    }).pipe(Effect.provide(Layer.merge(op.layer, templateFile)));
  });
});

const SENTINEL = "SENTINEL-do-not-leak";
const loginItem = {
  id: "abc123",
  title: "Acme",
  version: 2,
  vault: { id: "vault1", name: "Agents" },
  category: "LOGIN",
  additional_information: SENTINEL,
  urls: [{ label: "website", primary: true, href: "https://acme.test/login" }],
  fields: [
    { id: "username", type: "STRING", purpose: "USERNAME", label: "email", value: SENTINEL },
    {
      id: "password",
      type: "CONCEALED",
      purpose: "PASSWORD",
      label: "new-password",
      value: SENTINEL,
    },
    { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: SENTINEL },
    {
      id: "TOTP_x1",
      section: { id: "Section_1" },
      type: "OTP",
      label: "one-time password",
      value: SENTINEL,
      totp: SENTINEL,
      reference: `op://Agents/Acme/Section_1/${SENTINEL}`,
    },
  ],
};

describe("1Password driver logins", () => {
  const logins = driver.logins!;

  it.effect("lists only allowlisted login metadata from one vault", () => {
    const op = fakeOp(() => ({
      stdout: JSON.stringify([
        { ...loginItem, fields: undefined },
        { ...loginItem, id: "note1", category: "SECURE_NOTE" },
      ]),
    }));
    return Effect.gen(function* () {
      const listed = yield* logins.list({ account }, "vault1");
      assert.deepStrictEqual(listed, [
        { id: "abc123", title: "Acme", urls: ["https://acme.test/login"] },
      ]);
      assert.notInclude(JSON.stringify(listed), SENTINEL);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "item",
          "list",
          "--account=my.1password.com",
          "--vault=vault1",
          "--categories=Login",
          "--format=json",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("finds fillable fields by purpose and type, as id references, without values", () => {
    const op = fakeOp(() => ({ stdout: JSON.stringify(loginItem) }));
    return Effect.gen(function* () {
      const detail = yield* logins.get({ account }, "vault1", "abc123");
      assert.deepStrictEqual(detail, {
        id: "abc123",
        title: "Acme",
        urls: ["https://acme.test/login"],
        fields: {
          username: "op://vault1/abc123/username",
          password: "op://vault1/abc123/password",
          otp: "op://vault1/abc123/TOTP_x1?attribute=otp",
        },
      });
      assert.notInclude(JSON.stringify(detail), SENTINEL);
      assert.deepStrictEqual(op.invocations[0]?.slice(1, 4), ["item", "get", "abc123"]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("maps op failures to reasons and never asks for an id that is not one", () => {
    const answers: Record<string, OpResult> = {
      vault: { code: 1, stderr: '[ERROR] "nope" isn\'t a vault in this account.' },
      item: { code: 1, stderr: '[ERROR] "zzz" isn\'t an item in the "vault1" vault.' },
      locked: { code: 1, stderr: "[ERROR] error initializing client: authorization timeout" },
      garbled: { stdout: `not json ${SENTINEL}` },
    };
    let answer: OpResult = {};
    const op = fakeOp(() => answer);
    const reasonOf = <A, R>(effect: Effect.Effect<A, SecretProviderLoginsError, R>) =>
      Effect.flip(effect).pipe(Effect.map((error) => error.reason));
    return Effect.gen(function* () {
      answer = answers.vault!;
      assert.strictEqual(yield* reasonOf(logins.list({ account }, "nope")), "vaultNotFound");
      answer = answers.item!;
      assert.strictEqual(yield* reasonOf(logins.get({ account }, "vault1", "zzz")), "itemNotFound");
      answer = answers.locked!;
      assert.strictEqual(yield* reasonOf(logins.list({ account }, "vault1")), "unavailable");
      answer = answers.garbled!;
      assert.strictEqual(yield* reasonOf(logins.list({ account }, "vault1")), "unavailable");
      const calls = op.invocations.length;
      assert.strictEqual(
        yield* reasonOf(logins.get({ account }, "vault1", "--reveal")),
        "itemNotFound",
      );
      assert.strictEqual(op.invocations.length, calls);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("lists vault names and ids, and none through 1Password Connect", () => {
    const op = fakeOp(() => ({
      stdout: JSON.stringify([
        { id: "vault1", name: "Agents", content_version: 3, items: SENTINEL },
      ]),
    }));
    const env = (vars: Record<string, string>) =>
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: vars })));
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* logins.vaults({ account }).pipe(env({})),
        Option.some([{ id: "vault1", name: "Agents" }]),
      );
      assert.deepStrictEqual(op.invocations[0]?.slice(1), [
        "vault",
        "list",
        "--account=my.1password.com",
        "--format=json",
      ]);
      assert.deepStrictEqual(
        yield* logins.vaults({ account }).pipe(env({ OP_CONNECT_HOST: "https://c" })),
        Option.none(),
      );
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });
});
