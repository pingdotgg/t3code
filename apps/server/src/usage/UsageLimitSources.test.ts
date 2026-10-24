import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      commandSpawnerLayer({}),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

const VALID_COMMAND_OUTPUT = JSON.stringify({
  accounts: [
    {
      id: "droid-b",
      driver: "droid",
      email: "support@scenextras.com",
      plan: "pro",
      usageLimits: {
        checkedAt: "2026-10-23T00:00:00.000Z",
        windows: [
          {
            id: "monthly",
            kind: "monthly",
            label: "Monthly quota",
            usedPercent: 41,
          },
        ],
      },
    },
  ],
});

const commandSpawnerLayer = (
  outputs: Readonly<
    Record<string, { stdout: string | Uint8Array; stderr?: string; exitCode: number }>
  >,
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const result = "command" in command ? outputs[command.command] : undefined;
      if (result === undefined) {
        return Effect.die(
          `Unexpected command: ${"command" in command ? command.command : "piped"}`,
        );
      }
      const encode = new TextEncoder();
      const stdoutBytes =
        typeof result.stdout === "string" ? encode.encode(result.stdout) : result.stdout;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: stdoutBytes.length > 0 ? Stream.make(stdoutBytes) : Stream.empty,
          stderr:
            (result.stderr ?? "").length > 0
              ? Stream.make(encode.encode(result.stderr ?? ""))
              : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

it.effect("reads accounts from command sources and reports command failures", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;

    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    expect(snapshots.length).toBe(5);

    const ok = byId.get(UsageLimitSourceId.make("command-ok"));
    expect(ok?.kind).toBe("command");
    expect(ok?.label).toBe("/usr/local/bin/droidpool");
    expect(ok?.error).toBeUndefined();
    expect(ok?.accounts).toEqual([
      {
        id: "droid-b",
        driver: "droid",
        email: "support@scenextras.com",
        plan: "pro",
        usageLimits: {
          checkedAt: "2026-10-23T00:00:00.000Z",
          windows: [
            {
              id: "monthly",
              kind: "monthly",
              label: "Monthly quota",
              usedPercent: 41,
            },
          ],
        },
      },
    ]);

    const named = byId.get(UsageLimitSourceId.make("command-named"));
    expect(named?.label).toBe("Pool status");
    expect(named?.accounts.length).toBe(1);

    const malformed = byId.get(UsageLimitSourceId.make("command-bad-json"));
    expect(malformed?.accounts).toEqual([]);
    expect(malformed?.error).toBe(
      'The command\'s output is not valid usage-limit JSON (expected { "accounts": [...] }).',
    );

    const failing = byId.get(UsageLimitSourceId.make("command-fails"));
    expect(failing?.accounts).toEqual([]);
    expect(failing?.error).toBe(
      "The command failed with exit code 3. pool is locked by another process",
    );

    const overflow = byId.get(UsageLimitSourceId.make("command-overflow"));
    expect(overflow?.accounts).toEqual([]);
    expect(overflow?.error).toBe("The command produced more than 4 MiB of output.");

    const reset = yield* sources
      .consumeResetCredit({
        sourceId: UsageLimitSourceId.make("command-ok"),
        accountId: "droid-b",
        creditId: "credit-1",
      })
      .pipe(Effect.result);
    expect(reset._tag).toBe("Failure");
    if (reset._tag === "Failure") {
      expect(reset.failure.detail).toBe(
        "Reset credits are only available for CLIProxyAPI hub sources.",
      );
    }
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("command-ok")]: {
            kind: "command",
            command: "/usr/local/bin/droidpool",
            args: ["list", "--json"],
            enabled: true,
          },
          [UsageLimitSourceId.make("command-named")]: {
            kind: "command",
            label: "Pool status",
            command: "/usr/local/bin/droidpool2",
            enabled: true,
          },
          [UsageLimitSourceId.make("command-bad-json")]: {
            kind: "command",
            command: "/usr/local/bin/bad-json",
            enabled: true,
          },
          [UsageLimitSourceId.make("command-fails")]: {
            kind: "command",
            command: "/usr/local/bin/fails",
            enabled: true,
          },
          [UsageLimitSourceId.make("command-overflow")]: {
            kind: "command",
            command: "/usr/local/bin/overflow",
            enabled: true,
          },
          [UsageLimitSourceId.make("command-off")]: {
            kind: "command",
            command: "/usr/local/bin/droidpool",
            enabled: false,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      commandSpawnerLayer({
        "/usr/local/bin/droidpool": { stdout: VALID_COMMAND_OUTPUT, exitCode: 0 },
        "/usr/local/bin/droidpool2": { stdout: VALID_COMMAND_OUTPUT, exitCode: 0 },
        "/usr/local/bin/bad-json": { stdout: "not json at all", exitCode: 0 },
        "/usr/local/bin/fails": {
          stdout: "",
          stderr: "warning: something minor\npool is locked by another process\n",
          exitCode: 3,
        },
        "/usr/local/bin/overflow": {
          stdout: new Uint8Array(5 * 1024 * 1024),
          exitCode: 0,
        },
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
