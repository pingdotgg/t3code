import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitHubAccountId, type GitHubOAuthState } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubOAuth from "./GitHubOAuth.ts";

const encoder = new TextEncoder();

const waitForPhase = Effect.fn("GitHubOAuth.test.waitForPhase")(function* (
  oauth: GitHubOAuth.GitHubOAuth["Service"],
  accountId: GitHubAccountId,
  phase: GitHubOAuthState["phase"],
) {
  const reached = yield* Deferred.make<void>();
  const fiber = yield* oauth.subscribe(accountId).pipe(
    Stream.runForEach((state) =>
      state.phase === phase ? Deferred.succeed(reached, undefined) : Effect.void,
    ),
    Effect.forkScoped,
  );
  return { reached, fiber };
});

it.layer(NodeServices.layer)("GitHubOAuth", (it) => {
  it.effect("surfaces a pre-subscription device code and persists the OAuth credential", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
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
            stderr: Stream.make(encoder.encode("! First copy your one-time code: TEST-CODE\n")),
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
        const waiting = yield* waitForPhase(oauth, accountId, "waiting");
        const succeeded = yield* waitForPhase(oauth, accountId, "succeeded");
        yield* oauth.start({ accountId, label: "Personal", host: "github.com" });
        yield* Deferred.await(waiting.reached);
        const waitingState = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(waitingState));
        assert.equal(Option.getOrThrow(waitingState).userCode, "TEST-CODE");
        assert.equal(
          Option.getOrThrow(waitingState).verificationUrl,
          "https://github.com/login/device",
        );

        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        yield* Deferred.await(succeeded.reached);
        const succeededState = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(succeededState));
        assert.equal(Option.getOrThrow(succeededState).account?.login, "octocat");
        assert.isTrue((yield* settings.getSettings).githubAccounts[accountId]?.tokenConfigured);
        yield* Fiber.interrupt(waiting.fiber);
        yield* Fiber.interrupt(succeeded.fiber);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("rejects a stale account snapshot before starting OAuth", () =>
    Effect.gen(function* () {
      const accountId = GitHubAccountId.make("stale-start");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.die("OAuth must not start with stale account metadata."),
      );
      const settingsLayer = ServerSettings.ServerSettingsService.layerTest({
        githubAccounts: {
          [accountId]: { label: "Current", host: "github.com", tokenConfigured: false },
        },
      });
      const layer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("OAuth must not verify with stale account metadata."),
          }),
        ),
        Layer.provide(settingsLayer),
      );
      const providedLayer = Layer.merge(layer, settingsLayer);

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const error = yield* Effect.flip(
          oauth.start({ accountId, label: "Stale", host: "enterprise.example.com" }),
        );
        assert.equal(
          error.message,
          "The GitHub account settings changed before sign-in started. Refresh and try again.",
        );
      }).pipe(Effect.provide(providedLayer));
    }),
  );

  it.effect("rejects completion after account metadata changes", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const accountId = GitHubAccountId.make("metadata-race");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(8),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("one-time code: METADATA-RACE\n")),
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
          [accountId]: { label: "Original", host: "github.com", tokenConfigured: false },
        },
      });
      const layer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, processRunner)),
        Layer.provide(settingsLayer),
      );
      const providedLayer = Layer.merge(layer, settingsLayer);

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const settings = yield* ServerSettings.ServerSettingsService;
        const waiting = yield* waitForPhase(oauth, accountId, "waiting");
        const failed = yield* waitForPhase(oauth, accountId, "failed");
        yield* oauth.start({ accountId, label: "Original", host: "github.com" });
        yield* Deferred.await(waiting.reached);

        yield* settings.updateSettings({
          githubAccounts: {
            [accountId]: { label: "Updated", host: "enterprise.example.com" },
          },
        });
        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        yield* Deferred.await(failed.reached);

        const state = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(state));
        assert.equal(
          Option.getOrThrow(state).message,
          "The GitHub account settings changed before sign-in completed. Start sign-in again.",
        );
        assert.deepEqual((yield* settings.getSettings).githubAccounts[accountId], {
          label: "Updated",
          host: "enterprise.example.com",
          tokenConfigured: false,
        });
        yield* Fiber.interrupt(waiting.fiber);
        yield* Fiber.interrupt(failed.fiber);
      }).pipe(Effect.provide(providedLayer));
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
        const account = yield* waitForPhase(oauth, accountId, "waiting");
        const started = yield* oauth.start({
          accountId,
          label: "Cancelled",
          host: "github.com",
        });
        yield* Deferred.await(account.reached);
        const cancelled = yield* oauth.cancel(accountId, started.flowId!);
        assert.equal(cancelled.phase, "cancelled");
        assert.isTrue(killed);
        yield* Fiber.interrupt(account.fiber);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("cancels an active flow when its last subscription disconnects", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      let killed = false;
      const accountId = GitHubAccountId.make("disconnected");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(3),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.sync(() => void (killed = true)),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("one-time code: DISCONNECT-ME\n")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const layer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("Verification must not run after disconnect."),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      );

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const subscription = yield* waitForPhase(oauth, accountId, "waiting");
        yield* oauth.start({ accountId, label: "Disconnected", host: "github.com" });
        yield* Deferred.await(subscription.reached);
        yield* Fiber.interrupt(subscription.fiber);

        const cancelled = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(cancelled));
        assert.equal(Option.getOrThrow(cancelled).phase, "cancelled");
        assert.isTrue(killed);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("times out an abandoned GitHub sign-in and kills its process", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      let killed = false;
      const accountId = GitHubAccountId.make("timed-out");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.sync(() => void (killed = true)),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("one-time code: TIMEOUT-ME\n")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const layer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("Verification must not run after timeout."),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      );

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const waiting = yield* waitForPhase(oauth, accountId, "waiting");
        const failed = yield* waitForPhase(oauth, accountId, "failed");
        yield* oauth.start({ accountId, label: "Timed out", host: "github.com" });
        yield* Deferred.await(waiting.reached);
        yield* TestClock.adjust(GitHubOAuth.GITHUB_OAUTH_FLOW_TIMEOUT);
        yield* Deferred.await(failed.reached);
        assert.isTrue(killed);
        const state = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(state));
        assert.equal(
          Option.getOrThrow(state).message,
          "GitHub sign-in timed out. Start sign-in again.",
        );
        yield* Fiber.interrupt(waiting.fiber);
        yield* Fiber.interrupt(failed.fiber);
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())));
    }),
  );

  it.effect("reaps terminal state for many unknown account IDs", () =>
    Effect.gen(function* () {
      const accountIds = Array.from({ length: 32 }, (_, index) =>
        GitHubAccountId.make(`unknown-${index}`),
      );
      let nextPid = 10;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(nextPid++),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const layer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () => Effect.die("Verification must not run after an authorization failure."),
          }),
        ),
        Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      );

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        for (const accountId of accountIds) {
          yield* oauth.start({ accountId, label: "Unknown", host: "github.com" });
          const failed = yield* oauth.subscribe(accountId).pipe(
            Stream.filter((state) => state.phase === "failed"),
            Stream.runHead,
          );
          assert.isTrue(Option.isSome(failed));
        }

        yield* Effect.yieldNow;
        yield* TestClock.adjust(GitHubOAuth.GITHUB_OAUTH_STATE_RETENTION);
        for (const accountId of accountIds) {
          const state = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
          assert.isTrue(Option.isSome(state));
          assert.equal(Option.getOrThrow(state).phase, "idle");
        }
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())));
    }),
  );

  it.effect("does not restore an account removed while sign-in is active", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const accountId = GitHubAccountId.make("removed");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(5),
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
        const waiting = yield* waitForPhase(oauth, accountId, "waiting");
        const failed = yield* waitForPhase(oauth, accountId, "failed");
        yield* oauth.start({ accountId, label: "Removed later", host: "github.com" });
        yield* Deferred.await(waiting.reached);

        yield* settings.updateSettings({ githubAccounts: {} });
        assert.isUndefined((yield* settings.getSettings).githubAccounts[accountId]);

        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        yield* Deferred.await(failed.reached);
        const failedState = yield* oauth.subscribe(accountId).pipe(Stream.runHead);
        assert.isTrue(Option.isSome(failedState));
        assert.equal(
          Option.getOrThrow(failedState).message,
          "The GitHub account was removed before sign-in completed.",
        );
        assert.isUndefined((yield* settings.getSettings).githubAccounts[accountId]);
        yield* Fiber.interrupt(waiting.fiber);
        yield* Fiber.interrupt(failed.fiber);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not recreate an account when deletion races credential persistence", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const persistenceEntered = yield* Deferred.make<void>();
      const allowPersistence = yield* Deferred.make<void>();
      const accountId = GitHubAccountId.make("delete-race");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(6),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("one-time code: DELETE-RACE\n")),
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
      const baseSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        githubAccounts: {
          [accountId]: { label: "Delete race", host: "github.com", tokenConfigured: false },
        },
      });
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const base = yield* ServerSettings.ServerSettingsService;
          let settingsReads = 0;
          return ServerSettings.ServerSettingsService.of({
            ...base,
            getSettings: Effect.gen(function* () {
              const settings = yield* base.getSettings;
              settingsReads += 1;
              if (settingsReads === 2) {
                yield* Deferred.succeed(persistenceEntered, undefined);
                yield* Deferred.await(allowPersistence);
              }
              return settings;
            }),
            persistGitHubAccountTokenIfCurrent: (input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(persistenceEntered, undefined);
                yield* Deferred.await(allowPersistence);
                return yield* base.persistGitHubAccountTokenIfCurrent(input);
              }),
          });
        }),
      ).pipe(Layer.provide(baseSettingsLayer));
      const oauthLayer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, processRunner)),
        Layer.provide(settingsLayer),
      );
      const layer = Layer.merge(oauthLayer, settingsLayer);

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const settings = yield* ServerSettings.ServerSettingsService;
        const waiting = yield* waitForPhase(oauth, accountId, "waiting");
        yield* oauth.start({ accountId, label: "Delete race", host: "github.com" });
        yield* Deferred.await(waiting.reached);

        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        yield* Deferred.await(persistenceEntered);
        yield* settings.updateSettings({ githubAccounts: {} });
        yield* Deferred.succeed(allowPersistence, undefined);

        const terminal = yield* oauth.subscribe(accountId).pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(terminal));
        assert.equal(Option.getOrThrow(terminal).phase, "failed");
        assert.isUndefined((yield* settings.getSettings).githubAccounts[accountId]);
        yield* Fiber.interrupt(waiting.fiber);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("serializes cancellation with a credential commit", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const persistenceEntered = yield* Deferred.make<void>();
      const allowPersistence = yield* Deferred.make<void>();
      const cancelFinished = yield* Deferred.make<GitHubOAuthState>();
      const accountId = GitHubAccountId.make("cancel-race");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(7),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.make(encoder.encode("one-time code: CANCEL-RACE\n")),
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
      const baseSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        githubAccounts: {
          [accountId]: { label: "Cancel race", host: "github.com", tokenConfigured: false },
        },
      });
      const settingsLayer = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const base = yield* ServerSettings.ServerSettingsService;
          let settingsReads = 0;
          return ServerSettings.ServerSettingsService.of({
            ...base,
            getSettings: Effect.gen(function* () {
              const settings = yield* base.getSettings;
              settingsReads += 1;
              if (settingsReads === 2) {
                yield* Deferred.succeed(persistenceEntered, undefined);
                yield* Deferred.await(allowPersistence);
              }
              return settings;
            }),
            persistGitHubAccountTokenIfCurrent: (input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(persistenceEntered, undefined);
                yield* Deferred.await(allowPersistence);
                return yield* base.persistGitHubAccountTokenIfCurrent(input);
              }),
          });
        }),
      ).pipe(Layer.provide(baseSettingsLayer));
      const oauthLayer = GitHubOAuth.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, processRunner)),
        Layer.provide(settingsLayer),
      );
      const layer = Layer.merge(oauthLayer, settingsLayer);

      yield* Effect.gen(function* () {
        const oauth = yield* GitHubOAuth.GitHubOAuth;
        const settings = yield* ServerSettings.ServerSettingsService;
        const waiting = yield* waitForPhase(oauth, accountId, "waiting");
        const started = yield* oauth.start({
          accountId,
          label: "Cancel race",
          host: "github.com",
        });
        yield* Deferred.await(waiting.reached);

        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        yield* Deferred.await(persistenceEntered);
        const cancelFiber = yield* Effect.gen(function* () {
          const cancelled = yield* oauth.cancel(accountId, started.flowId!);
          yield* Deferred.succeed(cancelFinished, cancelled);
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Deferred.poll(cancelFinished)));

        yield* Deferred.succeed(allowPersistence, undefined);
        const cancelled = yield* Deferred.await(cancelFinished);
        assert.equal(cancelled.phase, "succeeded");
        assert.isTrue((yield* settings.getSettings).githubAccounts[accountId]?.tokenConfigured);
        yield* Fiber.interrupt(cancelFiber);
        yield* Fiber.interrupt(waiting.fiber);
      }).pipe(Effect.provide(layer));
    }),
  );
});
