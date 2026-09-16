import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitHubAccountId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubOAuth from "./GitHubOAuth.ts";

const encoder = new TextEncoder();

it.layer(NodeServices.layer)("GitHubOAuth", (it) => {
  it.effect("surfaces a pre-subscription device code and persists the OAuth credential", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const waitingPublished = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.concat(
              Stream.make(encoder.encode("! First copy your one-time code: TEST-CODE\n")),
              Stream.fromEffect(Deferred.succeed(waitingPublished, undefined)).pipe(Stream.drain),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const processRunner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed({
            stdout: input.args[0] === "api" ? "octocat\n" : "oauth-secret\n",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      });
      const accountId = GitHubAccountId.make("octocat");
      const settingsLayer = ServerSettings.ServerSettingsService.layerTest();
      const oauthLayer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, processRunner)),
        Layer.provide(settingsLayer),
      );
      const layer = Layer.merge(oauthLayer, settingsLayer);

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* oauth.start({ accountId, label: "Personal", host: "github.com" });
        yield* Deferred.await(waitingPublished);
        const waiting = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(waiting));
        assert.equal(Option.getOrThrow(waiting).userCode, "TEST-CODE");
        assert.equal(Option.getOrThrow(waiting).verificationUrl, "https://github.com/login/device");

        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        const succeeded = yield* oauth.subscribe(accountId).pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(succeeded));
        assert.equal(Option.getOrThrow(succeeded).account?.login, "octocat");
        assert.isTrue((yield* settings.getSettings).githubAccounts[accountId]?.tokenConfigured);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("cancels an active GitHub sign-in and stops its process", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      let killed = false;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.sync(() => void (killed = true)),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("one-time code: STOP-ME\n")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const accountId = GitHubAccountId.make("cancelled");
      const layer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("Verification must not run after cancellation."),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      );

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const started = yield* oauth.start({
          accountId,
          label: "Cancelled",
          host: "github.com",
        });
        yield* oauth.subscribe(accountId).pipe(
          Stream.filter((state) => state.phase === "waiting"),
          Stream.runHead,
        );
        const cancelled = yield* oauth.cancel(accountId, started.flowId!);
        assert.equal(cancelled.phase, "cancelled");
        assert.isTrue(killed);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not restore an account removed while sign-in is active", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const accountId = GitHubAccountId.make("removed");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(3),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("one-time code: REMOVE-ME\n")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const processRunner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.succeed({
            stdout: input.args[0] === "api" ? "octocat\n" : "oauth-secret\n",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      });
      const settingsLayer = ServerSettings.ServerSettingsService.layerTest({
        githubAccounts: {
          [accountId]: { label: "Removed later", host: "github.com", tokenConfigured: false },
        },
      });
      const oauthLayer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, processRunner)),
        Layer.provide(settingsLayer),
      );
      const layer = Layer.merge(oauthLayer, settingsLayer);

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* oauth.start({ accountId, label: "Removed later", host: "github.com" });
        const waiting = yield* oauth.subscribe(accountId).pipe(
          Stream.filter((state) => state.phase === "waiting"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(waiting));

        yield* settings.updateSettings({ githubAccounts: {} });
        assert.isUndefined((yield* settings.getSettings).githubAccounts[accountId]);

        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        const failed = yield* oauth.subscribe(accountId).pipe(
          Stream.filter((state) => state.phase === "failed"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(failed));
        assert.equal(
          Option.getOrThrow(failed).message,
          "The GitHub account was removed before sign-in completed.",
        );
        assert.isUndefined((yield* settings.getSettings).githubAccounts[accountId]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
