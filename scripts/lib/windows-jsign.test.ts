import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { signWithJsign } from "./windows-jsign.ts";

const UNSIGNED = "MZ unsigned payload";
const TRANSIENT_CHAIN =
  "jsign: Unable to retrieve the certificate chain 'acct/profile'\nCaused by: java.io.IOException: InternalError - An internal error has occurred.\n";
const TRANSIENT_SIGN =
  "jsign: Couldn't sign t3.exe\nCaused by: java.security.GeneralSecurityException: java.io.IOException: InternalError - An internal error has occurred.\n";
const BAD_SECRET =
  "jsign: Unable to retrieve the certificate chain 'acct/profile'\nCaused by: java.io.IOException: AADSTS7000215: Invalid client secret provided.\n";

/** What the stub does with the file jsign was given: sign it, or write junk and fail. */
type Reply = { readonly exitCode: number; readonly stderr?: string; readonly write?: string };

/** Stands in for jsign. Records the bytes it received and applies each reply in turn. */
function stubJsign(replies: ReadonlyArray<Reply>) {
  const inputs: Array<{ readonly path: string; readonly content: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
      const target = args.at(-1)!;
      inputs.push({ path: target, content: yield* fs.readFileString(target) });
      const reply = replies[inputs.length - 1] ?? replies.at(-1)!;
      if (reply.write !== undefined) yield* fs.writeFileString(target, reply.write);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: reply.stderr ? Stream.make(new TextEncoder().encode(reply.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
  );
  return { inputs, spawner };
}

const signed = (content: string): Reply => ({ exitCode: 0, write: `${content}+signature` });

const runSign = Effect.fn("test.runSign")(function* (replies: ReadonlyArray<Reply>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jsign-" });
  const file = path.join(dir, "t3.exe");
  yield* fs.writeFileString(file, UNSIGNED);
  const stub = stubJsign(replies);
  const sleeps: Array<number> = [];
  const clock = yield* Clock.Clock;
  const exit = yield* signWithJsign(file).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner),
    // Records the backoff instead of waiting it out.
    Effect.provideService(Clock.Clock, {
      ...clock,
      sleep: (duration) => Effect.sync(() => sleeps.push(Duration.toSeconds(duration))),
    }),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
            AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "acct",
            AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
          },
        }),
      ),
    ),
    Effect.exit,
  );
  return {
    ok: Exit.isSuccess(exit),
    error: Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined,
    sleeps,
    inputs: stub.inputs,
    // jsign only ever sees a disposable copy, never the file itself.
    signedInPlace: stub.inputs.some((input) => input.path === file),
    content: yield* fs.readFileString(file),
    // Only the original file is left: every attempt's copy is cleaned up.
    entries: yield* fs.readDirectory(dir),
  };
});

it.layer(NodeServices.layer)("signWithJsign", (it) => {
  it.effect("retries transient Azure errors on a fresh copy and keeps only the signed file", () =>
    Effect.gen(function* () {
      const result = yield* runSign([
        { exitCode: 1, stderr: TRANSIENT_CHAIN },
        // A partial write must not reach the next attempt or the original.
        { exitCode: 1, stderr: TRANSIENT_SIGN, write: "MZ half-written" },
        signed(UNSIGNED),
      ]);
      assert.isTrue(result.ok);
      assert.strictEqual(result.content, `${UNSIGNED}+signature`);
      assert.deepStrictEqual(
        result.inputs.map((input) => input.content),
        [UNSIGNED, UNSIGNED, UNSIGNED],
      );
      assert.isFalse(result.signedInPlace);
      assert.deepStrictEqual(result.sleeps, [5, 10]);
      assert.deepStrictEqual(result.entries, ["t3.exe"]);
    }),
  );

  it.effect("fails once without retrying on errors that are not transient", () =>
    Effect.gen(function* () {
      for (const reply of [
        { exitCode: 1, stderr: BAD_SECRET },
        { exitCode: 1, stderr: "jsign: Unsupported file: t3.exe\n", write: "MZ half-written" },
      ]) {
        const result = yield* runSign([reply, signed(UNSIGNED)]);
        assert.strictEqual(result.error?._tag, "JsignFailedError");
        assert.isFalse(result.error?._tag === "JsignFailedError" && result.error.transient);
        assert.strictEqual(result.inputs.length, 1);
        assert.deepStrictEqual(result.sleeps, []);
        assert.strictEqual(result.content, UNSIGNED);
        assert.deepStrictEqual(result.entries, ["t3.exe"]);
      }
    }),
  );

  it.effect("gives up after three retries and leaves the input unsigned", () =>
    Effect.gen(function* () {
      const result = yield* runSign([{ exitCode: 1, stderr: TRANSIENT_SIGN, write: "MZ junk" }]);
      assert.isTrue(result.error?._tag === "JsignFailedError" && result.error.transient);
      assert.strictEqual(result.inputs.length, 4);
      assert.deepStrictEqual(result.sleeps, [5, 10, 20]);
      assert.strictEqual(result.content, UNSIGNED);
      assert.deepStrictEqual(result.entries, ["t3.exe"]);
    }),
  );
});
