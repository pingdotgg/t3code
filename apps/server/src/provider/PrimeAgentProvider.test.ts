import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { PrimeAgentSettings } from "@t3tools/provider-prime-agent/settings";
import {
  checkPrimeAgentProviderStatus,
  PRIME_AGENT_INSTALL_COMMAND,
  PRIME_AGENT_PROVIDER_OPTION_ID,
  PRIME_AGENT_RLM_DEPTH_OPTION_ID,
  PRIME_AGENT_THINKING_OPTION_ID,
} from "@t3tools/provider-prime-agent/testing";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

const encoder = new TextEncoder();
const enabledSettings = Schema.decodeSync(PrimeAgentSettings)({ enabled: true });
const disabledSettings = Schema.decodeSync(PrimeAgentSettings)({ enabled: false });

interface CliOutput {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code: number;
  readonly delay?: Duration.Input;
}

function processHandle(output: CliOutput) {
  const answered = Effect.sleep(output.delay ?? 0);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_010),
    exitCode: Effect.as(answered, ChildProcessSpawner.ExitCode(output.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.unwrap(
      Effect.as(
        answered,
        output.stdout.length === 0 ? Stream.empty : Stream.succeed(encoder.encode(output.stdout)),
      ),
    ),
    stderr: output.stderr
      ? Stream.unwrap(Effect.as(answered, Stream.succeed(encoder.encode(output.stderr))))
      : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function primeAgentCli(outputs: Record<string, CliOutput | "missing">) {
  const invoked: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
    invoked.push(args);
    const scripted = outputs[args];
    if (scripted === "missing") {
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: "prime-agent",
          syscall: "spawn",
          description: "ENOENT",
        }),
      );
    }
    return Effect.succeed(processHandle(scripted ?? { stdout: "", code: 127 }));
  });
  return { invoked, spawner };
}

const baseLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe("PrimeAgentProvider status", () => {
  it.effect("returns disabled snapshot without spawning CLI when disabled", () =>
    Effect.gen(function* () {
      const { invoked, spawner } = primeAgentCli({});
      const result = yield* checkPrimeAgentProviderStatus(disabledSettings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(result.enabled, false);
      assert.equal(result.installed, false);
      assert.equal(invoked.length, 0);
      assert.include(result.message ?? "", "KBCode");
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("reports install curl guidance when prime-agent binary is missing", () =>
    Effect.gen(function* () {
      const { spawner } = primeAgentCli({ "--version": "missing" });
      const result = yield* checkPrimeAgentProviderStatus(enabledSettings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(result.installed, false);
      assert.equal(result.status, "error");
      assert.include(result.message ?? "", PRIME_AGENT_INSTALL_COMMAND);
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "probes version and status and exposes thinking, provider, RLM depth, and slash commands",
    () =>
      Effect.gen(function* () {
        const { invoked, spawner } = primeAgentCli({
          "--version": { code: 0, stdout: "prime-agent 0.3.1\n" },
          status: {
            code: 0,
            stdout: '{"authenticated":true,"provider":"anthropic","email":"dev@kbcode.dev"}\n',
          },
        });
        const result = yield* checkPrimeAgentProviderStatus(enabledSettings, {}).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        assert.deepEqual(invoked, ["--version", "status"]);
        assert.equal(result.installed, true);
        assert.equal(result.version, "0.3.1");
        assert.equal(result.status, "ready");
        assert.equal(result.auth.status, "authenticated");
        const slashNames = (result.slashCommands ?? []).map((cmd) => cmd.name);
        assert.includeMembers(slashNames, ["goal", "autonomous", "refine", "compact"]);
        const descriptors = result.models[0]?.capabilities?.optionDescriptors ?? [];
        const descriptorIds = descriptors.map((d) => d.id);
        assert.includeMembers(descriptorIds, [
          PRIME_AGENT_THINKING_OPTION_ID,
          PRIME_AGENT_PROVIDER_OPTION_ID,
          PRIME_AGENT_RLM_DEPTH_OPTION_ID,
        ]);
        const rlmDepth = descriptors.find((d) => d.id === PRIME_AGENT_RLM_DEPTH_OPTION_ID);
        assert.equal(rlmDepth?.type === "select" ? rlmDepth.currentValue : undefined, "2");
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("reports unauthenticated error when prime-agent status says not logged in", () =>
    Effect.gen(function* () {
      const { spawner } = primeAgentCli({
        "--version": { code: 0, stdout: "0.3.1\n" },
        status: { code: 1, stdout: "Not authenticated. Run /login.\n" },
      });
      const result = yield* checkPrimeAgentProviderStatus(enabledSettings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(result.installed, true);
      assert.equal(result.status, "error");
      assert.equal(result.auth.status, "unauthenticated");
      assert.include(result.message ?? "", "PRIME_API_KEY");
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("bounds hung --version probes with TestClock timeout", () =>
    Effect.gen(function* () {
      const { spawner } = primeAgentCli({
        "--version": { code: 0, stdout: "0.3.1\n", delay: "30 seconds" },
      });
      const fiber = yield* checkPrimeAgentProviderStatus(enabledSettings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );
      yield* TestClock.adjust("15 seconds");
      const result = yield* Fiber.join(fiber);
      assert.equal(result.status, "error");
      assert.include(result.message ?? "", "prime-agent --version");
    }).pipe(Effect.provide(baseLayer)),
  );
});
