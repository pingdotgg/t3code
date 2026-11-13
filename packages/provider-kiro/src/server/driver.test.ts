import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
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

import { KiroSettings } from "../settings.ts";
import { buildKiroAcpSpawnInput } from "./acpSupport.ts";
import { KiroDriver } from "./driver.ts";
import { kiroAuthFromWhoami } from "./status.ts";

const decodeSettings = Schema.decodeUnknownSync(KiroSettings);

describe("KiroDriver", () => {
  it("launches the V3 ACP engine with CLI-owned auth from the configured binary", () => {
    assert.deepEqual(buildKiroAcpSpawnInput(decodeSettings({}), "/work"), {
      command: "kiro-cli",
      args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
      cwd: "/work",
    });
    const custom = buildKiroAcpSpawnInput(
      decodeSettings({ binaryPath: "/opt/kiro/bin/kiro-cli" }),
      "/work",
      { KIRO_API_KEY: "ksk_test" },
    );
    assert.equal(custom.command, "/opt/kiro/bin/kiro-cli");
    assert.deepEqual(custom.args, ["acp", "--agent-engine=v3", "--auth-method=cli"]);
    assert.deepEqual(custom.env, { KIRO_API_KEY: "ksk_test" });
  });

  // Outputs recorded from `kiro-cli whoami --format json` on Kiro CLI 2.27.0.
  it("reads the sign-in state from kiro-cli whoami", () => {
    assert.deepEqual(kiroAuthFromWhoami({ code: 1, stdout: '{"account":null}\n' }, {}), {
      status: "unauthenticated",
    });
    assert.deepEqual(
      kiroAuthFromWhoami({ code: 0, stdout: '{"accountType":"ApiKey","email":null}\n' }, {}),
      { status: "authenticated", type: "api_key", label: "Kiro API key" },
    );
    assert.deepEqual(
      kiroAuthFromWhoami(
        { code: 0, stdout: '{"accountType":"BuilderId","email":"dev@example.com"}\n' },
        {},
      ),
      { status: "authenticated", label: "Kiro account", email: "dev@example.com" },
    );
    assert.deepEqual(kiroAuthFromWhoami({ code: 2, stdout: "error: service error" }, {}), {
      status: "unknown",
    });
    assert.deepEqual(kiroAuthFromWhoami(undefined, {}), { status: "unknown" });
  });

  // Reported from Kiro CLI 2.27.1 with an IAM Identity Center login (exit 0;
  // values are placeholders, layout unchanged).
  it("keeps the account email when whoami appends an Identity Center profile", () => {
    const stdout = [
      '{"accountType":"IamIdentityCenter","email":"jane.doe@example.com","region":"us-east-1","startUrl":"https://d-0123456789.awsapps.com/start"}',
      "",
      "Profile:",
      "KiroProfile-us-east-1",
      "arn:aws:codewhisperer:us-east-1:111122223333:profile/EXAMPLE12345",
      "",
    ].join("\n");
    assert.deepEqual(kiroAuthFromWhoami({ code: 0, stdout }, {}), {
      status: "authenticated",
      label: "Kiro account",
      email: "jane.doe@example.com",
    });
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

/** Records each spawned command and answers only `--version`. */
function recordingSpawner(launches: Array<string>) {
  return ChildProcessSpawner.make((command) => {
    const standard = ChildProcess.isStandardCommand(command);
    if (standard) launches.push(command.command);
    const version = standard && command.args.join(" ") === "--version";
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(version ? 0 : 2)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: version ? Stream.encodeText(Stream.make("2.32.0\n")) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.layer(layerTest)("KiroDriver binary path", (it) => {
  it.effect("probes a ~/ binary path from the home directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const launches: Array<string> = [];
      const instance = yield* KiroDriver.create({
        instanceId: ProviderInstanceId.make("kiro-home"),
        displayName: undefined,
        enabled: true,
        environment: [],
        config: decodeSettings({ binaryPath: "~/.local/bin/kiro-cli" }),
      }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(launches)),
      );
      const snapshot = yield* instance.snapshot.refresh;
      assert.isNotEmpty(launches);
      assert.deepEqual(
        [...new Set(launches)],
        [path.join("/test-home", ".local", "bin", "kiro-cli")],
      );
      assert.isTrue(snapshot.installed);
    }),
  );
});
