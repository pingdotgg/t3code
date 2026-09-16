import { describe, expect, it } from "@effect/vitest";
import { AuggieSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { checkAuggieProviderStatus } from "./AuggieProvider.ts";

const decodeAuggieSettings = Schema.decodeSync(AuggieSettings);

interface FakeCommandResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

/**
 * Answers each spawned `auggie` invocation by its first argument, so a test
 * can describe `--version` and `token print` independently. Records the
 * argument vectors so a test can assert which probes actually ran.
 */
const makeFakeSpawner = (responses: Record<string, FakeCommandResult>) => {
  const invocations: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    // `args` is internal to the spawned command; the probe's behavior is only
    // observable through which argv it asks for.
    const args = ((command as { readonly args?: ReadonlyArray<string> }).args ??
      []) as ReadonlyArray<string>;
    invocations.push(args);
    const key = args.find((arg) => arg === "--version" || arg === "token") ?? "";
    const response = responses[key] ?? { exitCode: 127 };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(response.stdout ?? "")),
        stderr: Stream.encodeText(Stream.make(response.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, invocations };
};

const runProbe = (
  responses: Record<string, FakeCommandResult>,
  environment: NodeJS.ProcessEnv = {},
  settings: Partial<{ enabled: boolean; binaryPath: string }> = {},
) => {
  const { spawner, invocations } = makeFakeSpawner(responses);
  return checkAuggieProviderStatus(
    decodeAuggieSettings({ enabled: true, ...settings }),
    environment,
  ).pipe(
    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Effect.map((snapshot) => ({ snapshot, invocations })),
  );
};

describe("checkAuggieProviderStatus", () => {
  it.effect("reports a signed-in CLI as ready with its version", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* runProbe({
        "--version": { stdout: "0.34.0 (commit 81042879)\n" },
        token: { stdout: '{"accessToken":"redacted"}\n' },
      });

      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.34.0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Augment account",
      });
    }),
  );

  it.effect("points a signed-out user at `auggie login`", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* runProbe({
        "--version": { stdout: "0.34.0\n" },
        token: { exitCode: 1, stderr: "Not logged in\n" },
      });

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("auggie login");
    }),
  );

  it.effect("treats a clean exit with no session as signed out", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* runProbe({
        "--version": { stdout: "0.34.0\n" },
        token: { stdout: "   \n" },
      });

      expect(snapshot.auth.status).toBe("unauthenticated");
    }),
  );

  it.effect("accepts an ambient session credential without shelling out for it", () =>
    Effect.gen(function* () {
      const { snapshot, invocations } = yield* runProbe(
        { "--version": { stdout: "0.34.0\n" } },
        { AUGMENT_SESSION_AUTH: '{"accessToken":"redacted"}' },
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "Augment session",
      });
      expect(invocations.some((args) => args.includes("token"))).toBe(false);
    }),
  );

  it.effect("never probes sign-in when the provider is disabled", () =>
    Effect.gen(function* () {
      const { snapshot, invocations } = yield* runProbe({}, {}, { enabled: false });

      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(invocations).toEqual([]);
    }),
  );
});
