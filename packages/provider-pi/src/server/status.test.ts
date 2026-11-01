import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { checkPiProviderStatus, MINIMUM_PI_VERSION } from "./status.ts";

const encoder = new TextEncoder();
const decodeRpcRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  /** Holds stdout and the exit back until it completes, like a CLI slow to answer. */
  readonly answered?: Effect.Effect<void>;
}) {
  const answered = input.answered ?? Effect.void;
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.as(answered, ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.unwrap(Effect.as(answered, bytes(input.stdout))),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

/** Fails the test if status runs `pi auth check` without `authCheck` or with other arguments. */
const piDiscoverySpawner = (
  inventory: unknown,
  options: {
    readonly version?: string;
    readonly state?: unknown;
    readonly authCheck?: string | undefined;
  } = {},
) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    let stdinBuffer = "";
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        stdinBuffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = stdinBuffer.indexOf("\n");
          if (newline === -1) return;
          const line = stdinBuffer.slice(0, newline);
          stdinBuffer = stdinBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          const request = decodeRpcRequest(line);
          const data =
            request.type === "get_available_models"
              ? inventory
              : request.type === "get_commands"
                ? { commands: [] }
                : request.type === "get_state"
                  ? (options.state ?? {})
                  : {};
          yield* Queue.offer(
            stdout,
            encoder.encode(
              `${encodeJsonLine({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
            ),
          );
        }
      }),
    );
    return ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      if (args.includes("--version")) {
        return Effect.succeed(processHandle({ stdout: `pi ${options.version ?? "0.84.3"}\n` }));
      }
      if (args[0] === "auth") {
        const expected = ["auth", "check", "--provider", "openai", "--json", "--no-refresh"];
        return options.authCheck === undefined || args.join(" ") !== expected.join(" ")
          ? Effect.die(`Unexpected pi ${args.join(" ")}`)
          : Effect.succeed(processHandle({ stdout: options.authCheck, exitCode: 1 }));
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          ...processHandle({}),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          stdin,
          stdout: Stream.fromQueue(stdout),
        }),
      );
    });
  });

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      label: "answers after 6 s",
      versionDelay: "6 seconds",
      status: "ready",
      version: "0.84.3",
      message: "could not refresh its models and commands",
      probesAfterVersion: true,
    },
    {
      label: "never answers",
      versionDelay: "Infinity",
      status: "error",
      version: null,
      message: "Pi CLI is installed but timed out while running `pi --version`.",
      probesAfterVersion: false,
    },
  ] as const)("gives `pi --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      const spawned: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        const args = ChildProcess.isStandardCommand(command) ? command.args : [];
        spawned.push(args.join(" "));
        return Effect.succeed(
          args.includes("--version")
            ? processHandle({ stdout: "pi 0.84.3\n", answered: Effect.sleep(row.versionDelay) })
            : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
        );
      });
      const fiber = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const snapshot = yield* Fiber.join(fiber);
      assert.equal(snapshot.status, row.status);
      assert.equal(snapshot.version, row.version);
      assert.include(snapshot.message ?? "", row.message);
      assert.equal(spawned.length > 1, row.probesAfterVersion);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a known unauthenticated inventory when Pi returns no usable models", () =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner({ models: [] });
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      label: "a pinned model without credentials",
      version: "1.4.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: '{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}',
      message: "Pi default (openai/gpt-5) has no credentials configured for openai.",
    },
    {
      label: "a pinned model with a runtime --api-key",
      version: "1.4.0",
      launchArgs: "--provider openai --model gpt-5 --api-key fake-key",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: undefined,
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
    },
    {
      label: "a pinned model whose provider auth check cannot find",
      version: "1.4.0",
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: '{"status":"not_ready","provider":"openai","reason":"provider_not_found"}',
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
    },
    {
      label: "a pinned model on Pi without auth check",
      version: MINIMUM_PI_VERSION,
      activeModel: { provider: "openai", id: "gpt-5" },
      authCheck: undefined,
      message: "Pi default (openai/gpt-5) uses openai, which has no available models in Pi.",
    },
    {
      label: "an uncatalogued model id of a provider with credentials",
      version: "1.4.0",
      activeModel: { provider: "anthropic", id: "claude-next" },
      authCheck: undefined,
      message: undefined,
    },
    {
      label: "an extension model Pi lists as available",
      version: "1.4.0",
      activeModel: { provider: "router", id: "auto" },
      authCheck: undefined,
      message: undefined,
    },
  ])("diagnoses Pi's active model readiness for $label", (row) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(
        {
          models: [
            { provider: "anthropic", id: "claude-sonnet-4" },
            { provider: "router", id: "auto" },
          ],
        },
        { version: row.version, state: { model: row.activeModel }, authCheck: row.authCheck },
      );
      const snapshot = yield* checkPiProviderStatus({
        ...settings,
        launchArgs: row.launchArgs ?? "",
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      if (row.message === undefined) assert.isUndefined(snapshot.message);
      else assert.include(snapshot.message ?? "", row.message);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // regression: #18498 a malformed model inventory must not restore stale Pi models
  it.effect.each([
    ["missing models", {}],
    ["missing model id", { models: [{ provider: "anthropic" }] }],
    [
      "mixed valid and invalid models",
      { models: [{ provider: "anthropic", id: "claude-sonnet-4" }, { provider: "openrouter" }] },
    ],
  ] as const)("reports unknown authentication when Pi discovery returns %s", (_label, inventory) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(inventory);
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
