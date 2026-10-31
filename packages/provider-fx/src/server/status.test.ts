import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { FxSettings } from "../settings.ts";
import { checkFxProviderStatus } from "./status.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(FxSettings)({ enabled: true });

/** A `stalled` process has started but never writes output or exits. */
function processHandle(stdout: string, code: number, stalled = false) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_101),
    exitCode: stalled ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stalled
      ? Stream.never
      : stdout.length === 0
        ? Stream.empty
        : Stream.succeed(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Answers `fx` invocations by their arguments and records which ran. */
const check = (statusJson: string, versionDelay: Duration.Input = 0, versionStalls = false) =>
  Effect.gen(function* () {
    const outputs: Record<string, string> = {
      "--version": "fx 0.0.13\n",
      "status --json": statusJson,
      // `fx models --json` from fx 0.0.13, ids trimmed.
      "models --json": JSON.stringify({
        kind: "models",
        count: 2,
        shown_count: 2,
        more_count: 0,
        private_models_hidden: false,
        ids: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"],
      }),
    };
    const invoked: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
      invoked.push(args);
      const stdout = outputs[args];
      if (args !== "--version") {
        return Effect.succeed(processHandle(stdout ?? "", stdout === undefined ? 2 : 0));
      }
      return Effect.delay(
        Effect.succeed(processHandle(stdout ?? "", 0, versionStalls)),
        versionDelay,
      );
    });
    const draft = yield* checkFxProviderStatus(settings, {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return { draft, invoked };
  }).pipe(Effect.provide(NodeServices.layer));

describe("checkFxProviderStatus", () => {
  it.effect.each([
    {
      label: "answers after 6 s",
      versionDelay: "6 seconds",
      versionStalls: false,
      status: "ready",
      version: "0.0.13",
      message: undefined,
      invoked: ["--version", "status --json", "models --json"],
    },
    {
      label: "never answers",
      versionDelay: "Infinity",
      versionStalls: false,
      status: "error",
      version: null,
      message: "Failed to run `fx --version`.",
      invoked: ["--version"],
    },
    {
      label: "starts but never answers",
      versionDelay: 0,
      versionStalls: true,
      status: "error",
      version: null,
      message: "Failed to run `fx --version`.",
      invoked: ["--version"],
    },
  ] as const)("gives `fx --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      const fiber = yield* check(
        JSON.stringify({ kind: "status", model: "anthropic/claude-opus-5.5", auth: "fx login" }),
        row.versionDelay,
        row.versionStalls,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const { draft, invoked } = yield* Fiber.join(fiber);
      assert.equal(draft.status, row.status);
      assert.equal(draft.version, row.version);
      assert.equal(draft.message, row.message);
      assert.deepEqual(invoked, [...row.invoked]);
    }),
  );

  // `fx status --json` from fx 0.0.13, trimmed to the fields T3 reads plus a few it ignores.
  it.effect("reports sign-in from `fx status` without opening an ACP session", () =>
    Effect.gen(function* () {
      const signedIn = yield* check(
        JSON.stringify({
          kind: "status",
          model: "anthropic/claude-opus-5.5",
          auth: "fx login",
          auth_refreshable: true,
          permission_mode: "ask",
        }),
      );
      assert.deepEqual(signedIn.invoked, ["--version", "status --json", "models --json"]);
      assert.equal(signedIn.draft.status, "ready");
      assert.equal(signedIn.draft.version, "0.0.13");
      assert.deepEqual(signedIn.draft.auth, { status: "authenticated", label: "fx login" });
      assert.deepEqual(
        signedIn.draft.models.map((model) => model.slug),
        ["default", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"],
      );
      // "Default" carries the model `fx status` reports, which the adapter selects for it.
      assert.deepEqual(signedIn.draft.models[0]?.aliases, ["anthropic/claude-opus-5.5"]);
      assert.isDefined(signedIn.draft.versionAdvisory);

      const signedOut = yield* check(
        JSON.stringify({
          kind: "status",
          model: "spacexai/grok-4.7",
          auth: "missing",
          auth_refreshable: false,
          auth_help:
            "fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.",
        }),
      );
      assert.equal(signedOut.draft.status, "error");
      assert.equal(signedOut.draft.auth.status, "unauthenticated");
      assert.equal(signedOut.draft.message, "Run `fx login` to sign in.");

      // An fx whose status output T3 cannot read is not reported as signed out.
      const unknown = yield* check("not json");
      assert.equal(unknown.draft.status, "warning");
      assert.equal(unknown.draft.auth.status, "unknown");
    }),
  );
});
