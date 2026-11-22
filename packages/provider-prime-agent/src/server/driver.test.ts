import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { PrimeAgentSettings } from "../settings.ts";
import {
  buildPrimeAgentAcpSpawnInput,
  PRIME_AGENT_PROVIDER_OPTION_ID,
  PRIME_AGENT_RLM_DEPTH_OPTION_ID,
  PRIME_AGENT_THINKING_OPTION_ID,
  primeAgentRequiresSessionRestart,
} from "./acpSupport.ts";
import { PrimeAgentDriver } from "./driver.ts";
import { primeAgentAuthFromStatus, primeAgentModelsFromList } from "./status.ts";

const decodeSettings = Schema.decodeUnknownSync(PrimeAgentSettings);
const instanceId = ProviderInstanceId.make("primeAgent");

describe("PrimeAgentDriver", () => {
  it("builds --mode acp spawn argv and RLM_MAX_DEPTH env from settings and model selection", () => {
    const defaults = buildPrimeAgentAcpSpawnInput({
      settings: decodeSettings({}),
      cwd: "/work/repo",
    });
    assert.equal(defaults.command, "prime-agent");
    assert.deepEqual(defaults.args, ["--mode", "acp", "--thinking", "medium"]);
    assert.equal(defaults.cwd, "/work/repo");
    assert.equal(defaults.env?.RLM_MAX_DEPTH, "2");

    const custom = buildPrimeAgentAcpSpawnInput({
      settings: decodeSettings({
        binaryPath: "/opt/prime/bin/prime-agent",
        autonomousMaxTurns: "30",
        autonomousMaxTokens: "150000",
      }),
      cwd: "/work/worktree-1",
      environment: { PRIME_API_KEY: "pk_test_123" },
      resumeSessionId: "sess_abc123",
      modelSelection: {
        instanceId,
        model: "claude-opus-4-6",
        options: [
          { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
          { id: PRIME_AGENT_THINKING_OPTION_ID, value: "high" },
          { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "0" },
        ],
      },
    });
    assert.equal(custom.command, "/opt/prime/bin/prime-agent");
    assert.deepEqual(custom.args, [
      "--mode",
      "acp",
      "--provider",
      "anthropic",
      "--model",
      "claude-opus-4-6",
      "--thinking",
      "high",
      "--resume",
      "sess_abc123",
      "--autonomous-max-turns",
      "30",
      "--autonomous-max-tokens",
      "150000",
    ]);
    assert.equal(custom.env?.PRIME_API_KEY, "pk_test_123");
    assert.equal(custom.env?.RLM_MAX_DEPTH, "0");
  });

  it("splits provider/model custom slugs when no explicit provider is chosen", () => {
    const spawn = buildPrimeAgentAcpSpawnInput({
      settings: decodeSettings({}),
      cwd: "/work",
      modelSelection: { instanceId, model: "openrouter/deepseek/deepseek-r1" },
    });
    assert.deepEqual(spawn.args, [
      "--mode",
      "acp",
      "--provider",
      "openrouter",
      "--model",
      "deepseek/deepseek-r1",
      "--thinking",
      "medium",
    ]);
  });

  it("requires session restart when startup-bound model, provider, thinking, or RLM depth changes", () => {
    const settings = decodeSettings({});
    const base: ModelSelection = {
      instanceId,
      model: "claude-sonnet-4-5",
      options: [
        { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
        { id: PRIME_AGENT_THINKING_OPTION_ID, value: "medium" },
        { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "2" },
      ],
    };

    assert.equal(primeAgentRequiresSessionRestart(base, base, settings), false);
    assert.equal(
      primeAgentRequiresSessionRestart(base, { ...base, model: "claude-opus-4-6" }, settings),
      true,
    );
    assert.equal(
      primeAgentRequiresSessionRestart(
        base,
        {
          ...base,
          options: [
            { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
            { id: PRIME_AGENT_THINKING_OPTION_ID, value: "high" },
            { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "2" },
          ],
        },
        settings,
      ),
      true,
    );
    assert.equal(
      primeAgentRequiresSessionRestart(
        base,
        {
          ...base,
          options: [
            { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
            { id: PRIME_AGENT_THINKING_OPTION_ID, value: "medium" },
            { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "0" },
          ],
        },
        settings,
      ),
      true,
    );
  });

  it("parses auth state from prime-agent status output and environment keys", () => {
    assert.deepEqual(primeAgentAuthFromStatus(undefined, { PRIME_API_KEY: "pk_live" }), {
      status: "authenticated",
      type: "api_key",
      label: "Prime API key",
    });
    assert.deepEqual(
      primeAgentAuthFromStatus(
        {
          code: 0,
          stdout: '{"authenticated":true,"provider":"anthropic","email":"dev@kbcode.dev"}',
        },
        {},
      ),
      { status: "authenticated", label: "Prime Agent (anthropic)", email: "dev@kbcode.dev" },
    );
    assert.deepEqual(
      primeAgentAuthFromStatus(
        { code: 1, stdout: "Not logged in. Run /login to authenticate." },
        {},
      ),
      { status: "unauthenticated" },
    );
    assert.deepEqual(
      primeAgentAuthFromStatus({ code: 0, stdout: "Active provider: openai\nLogged in" }, {}),
      { status: "authenticated", label: "Prime Agent" },
    );
    assert.deepEqual(primeAgentAuthFromStatus(undefined, {}), { status: "unknown" });
  });

  it("parses optional model list JSON while keeping default entry first", () => {
    const models = primeAgentModelsFromList({
      code: 0,
      stdout: JSON.stringify({
        models: [{ id: "claude-sonnet-4-5", name: "Sonnet 4.5", provider: "anthropic" }],
      }),
    });
    assert.equal(models?.[0]?.slug, "default");
    assert.equal(models?.[1]?.slug, "anthropic/claude-sonnet-4-5");
    assert.equal(models?.[1]?.name, "Sonnet 4.5");
  });
});

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

function recordingSpawner(launches: Array<string>) {
  return ChildProcessSpawner.make((command) => {
    const standard = ChildProcess.isStandardCommand(command);
    if (standard) launches.push(command.command);
    const isVersion = standard && command.args.join(" ") === "--version";
    const isStatus = standard && command.args.join(" ") === "status";
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(isVersion || isStatus ? 0 : 2)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: isVersion
          ? Stream.encodeText(Stream.make("0.4.2\n"))
          : isStatus
            ? Stream.encodeText(
                Stream.make('{"authenticated":true,"provider":"prime-inference"}\n'),
              )
            : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.layer(layerTest)("PrimeAgentDriver binary path", (it) => {
  it.effect("expands ~ in binaryPath before running status probes", () =>
    Effect.gen(function* () {
      const launches: Array<string> = [];
      const path = yield* Path.Path;
      const homeDir = yield* HostProcess.HomeDirectory;
      const instance = yield* PrimeAgentDriver.create({
        instanceId,
        displayName: "Prime Agent",
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: decodeSettings({ binaryPath: "~/.local/bin/prime-agent" }),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(launches)),
      );
      const refreshed = yield* instance.snapshot.refresh;
      assert.equal(refreshed.status, "ready");
      assert.equal(refreshed.version, "0.4.2");
      assert.equal(launches[0], path.join(homeDir, ".local/bin/prime-agent"));
    }),
  );
});
