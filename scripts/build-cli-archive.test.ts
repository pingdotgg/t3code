import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { awaitCliNotarization, signMacArchiveContents } from "./build-cli-archive.ts";

const signedEnv = {
  T3CODE_CLI_MAC_SIGN_IDENTITY: "Developer ID Application: Test (TEAM)",
  APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
  APPLE_API_KEY_ID: "TEST",
  APPLE_API_ISSUER: "issuer",
};

type NotaryReply = { readonly exitCode: number; readonly stdout?: string };

/** Stands in for `xcrun notarytool`, codesign and ditto; records each invocation. */
function stubSpawner(notary: (subcommand: string) => NotaryReply) {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const argv = ChildProcess.isStandardCommand(command)
      ? [command.command, ...command.args.map(String)]
      : [];
    calls.push(argv);
    const reply = argv[1] === "notarytool" ? notary(argv[2] ?? "") : { exitCode: 0 };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: reply.stdout ? Stream.make(new TextEncoder().encode(reply.stdout)) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { calls, spawner };
}

const withStubs = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  stub: ReturnType<typeof stubSpawner>,
  env: Record<string, string> = signedEnv,
) =>
  effect.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const makeContent = Effect.fn("test.makeContent")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-notary-" });
  const contentDir = path.join(root, "content");
  yield* fs.makeDirectory(contentDir);
  const executablePath = path.join(contentDir, "t3");
  yield* fs.writeFileString(executablePath, "t3");
  return { root, contentDir, executablePath, submissionFile: path.join(root, "submission") };
});

const notarySubcommands = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((argv) => argv[1] === "notarytool").map((argv) => argv.slice(2));

it.layer(NodeServices.layer)("build-cli-archive notarization", (it) => {
  it.effect("records a deferred submission without waiting, then gates on Accepted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Apple documents id and path for an unwaited submit; a pending status must not fail it.
      for (const submitted of [
        '{"id":"new-id","message":"Successfully uploaded file","path":"t3.zip"}',
        '{"id":"new-id","status":"In Progress"}',
      ]) {
        const content = yield* makeContent();
        yield* fs.writeFileString(content.submissionFile, "stale-id");
        const stub = stubSpawner((subcommand) =>
          subcommand === "submit"
            ? { exitCode: 0, stdout: submitted }
            : { exitCode: 0, stdout: '{"id":"new-id","status":"Accepted"}' },
        );

        yield* withStubs(
          signMacArchiveContents({
            repoRoot: content.root,
            contentDir: content.contentDir,
            executablePath: content.executablePath,
            notarySubmissionFile: Option.some(content.submissionFile),
          }),
          stub,
        );
        assert.equal(yield* fs.readFileString(content.submissionFile), "new-id");
        const [submit] = notarySubcommands(stub.calls);
        assert.equal(submit?.[0], "submit");
        assert.isFalse(submit?.includes("--wait"));

        yield* withStubs(awaitCliNotarization(content.submissionFile), stub);
        assert.deepEqual(notarySubcommands(stub.calls)[1]?.slice(0, 2), ["wait", "new-id"]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("fails the gate unless Apple accepted the submission", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly wait: NotaryReply;
        readonly submitted?: boolean;
        readonly env?: Record<string, string>;
        readonly error: string | undefined;
        readonly fetchesLog?: boolean;
      }> = [
        {
          name: "invalid",
          wait: { exitCode: 0, stdout: '{"id":"sub","status":"Invalid"}' },
          error: "CliArchiveNotarizationRejectedError",
          fetchesLog: true,
        },
        {
          name: "rejected with a non-zero exit",
          wait: { exitCode: 1, stdout: '{"id":"sub","status":"Rejected"}' },
          error: "CliArchiveNotarizationRejectedError",
          fetchesLog: true,
        },
        {
          name: "still in progress",
          wait: { exitCode: 0, stdout: '{"id":"sub","status":"In Progress"}' },
          error: "CliArchiveNotarizationRejectedError",
        },
        {
          name: "still in progress with a non-zero exit",
          wait: { exitCode: 1, stdout: '{"id":"sub","status":"In Progress"}' },
          error: "CliArchiveCommandFailedError",
        },
        {
          name: "notarytool failed",
          wait: { exitCode: 69 },
          error: "CliArchiveCommandFailedError",
        },
        {
          name: "no status",
          wait: { exitCode: 0, stdout: '{"id":"sub"}' },
          error: "CliArchiveNotarizationRejectedError",
        },
        {
          name: "accepted with a non-zero exit",
          wait: { exitCode: 1, stdout: '{"id":"sub","status":"Accepted"}' },
          error: "CliArchiveCommandFailedError",
        },
        {
          name: "submission missing",
          wait: { exitCode: 0, stdout: '{"id":"sub","status":"Accepted"}' },
          submitted: false,
          error: "CliArchiveInputMissingError",
        },
        {
          name: "submission without credentials",
          wait: { exitCode: 0, stdout: '{"id":"sub","status":"Accepted"}' },
          env: { T3CODE_CLI_MAC_SIGN_IDENTITY: signedEnv.T3CODE_CLI_MAC_SIGN_IDENTITY },
          error: "CliArchiveInputMissingError",
        },
        {
          name: "notarization not configured",
          wait: { exitCode: 0 },
          submitted: false,
          env: {},
          error: undefined,
        },
      ];
      for (const testCase of cases) {
        const content = yield* makeContent();
        if (testCase.submitted !== false) yield* fs.writeFileString(content.submissionFile, "sub");
        const stub = stubSpawner(() => testCase.wait);
        const exit = yield* withStubs(
          awaitCliNotarization(content.submissionFile),
          stub,
          testCase.env,
        ).pipe(Effect.flip, Effect.option);
        assert.equal(Option.getOrUndefined(exit)?._tag, testCase.error, testCase.name);
        assert.equal(
          notarySubcommands(stub.calls).some((argv) => argv[0] === "log"),
          testCase.fetchesLog ?? false,
          testCase.name,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("fails a standalone build whose waited submission is not Accepted", () =>
    Effect.gen(function* () {
      const content = yield* makeContent();
      const stub = stubSpawner(() => ({ exitCode: 0, stdout: '{"id":"sub","status":"Invalid"}' }));
      const error = yield* withStubs(
        signMacArchiveContents({
          repoRoot: content.root,
          contentDir: content.contentDir,
          executablePath: content.executablePath,
          notarySubmissionFile: Option.none(),
        }),
        stub,
      ).pipe(Effect.flip);
      assert.equal(error._tag, "CliArchiveNotarizationRejectedError");
      assert.isTrue(notarySubcommands(stub.calls)[0]?.includes("--wait"));
    }).pipe(Effect.scoped),
  );
});
