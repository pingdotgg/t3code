import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  layerSandboxProviderRegistry,
  SandboxProvider,
  type SandboxExecInput,
} from "@t3tools/sandbox-providers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  buildRepoCloneCommand,
  collectHostOAuthSyncPayload,
  extractPairingUrl,
} from "./SandboxBootstrap.ts";
import { SandboxConfig } from "./SandboxConfig.ts";
import * as SandboxOrchestratorService from "./SandboxOrchestratorService.ts";
import * as SandboxRepository from "./SandboxRepository.ts";

describe("SandboxOrchestratorService", () => {
  it.effect(
    "spawns, bootstraps with cloud machine kind, snapshots, stops, resumes, and destroys a sandbox",
    () =>
      Effect.gen(function* () {
        const execLog: SandboxExecInput[] = [];
        let snapshotCounter = 0;

        const fakeDriver = SandboxProvider.of({
          kind: "upstash-box",
          create: (input) =>
            Effect.succeed({
              providerSandboxId: `box-${input.name}`,
              state: "running" as const,
              connectionUrl: `https://${input.name}.upstash.app`,
            }),
          exec: (input) =>
            Effect.sync(() => {
              execLog.push(input);
              if (input.command.includes("pair")) {
                return {
                  exitCode: 0,
                  stdout: [
                    "Pairing with KBCode (http://127.0.0.1:3773).",
                    "",
                    "Pairing URL: http://127.0.0.1:3773/pair#token=abc123",
                    "Token: abc123",
                  ].join("\n"),
                  stderr: "",
                };
              }
              if (input.command.includes("environment")) {
                return { exitCode: 0, stdout: "env-cloud-1\n", stderr: "" };
              }
              return { exitCode: 0, stdout: "ok", stderr: "" };
            }),
          snapshot: () =>
            Effect.sync(() => {
              snapshotCounter += 1;
              return { snapshotId: `snap-${snapshotCounter}`, stoppedAfterSnapshot: false };
            }),
          pauseOrStop: () => Effect.succeed({ state: "paused" as const }),
          resume: (providerSandboxId) =>
            Effect.succeed({
              providerSandboxId,
              state: "running" as const,
              connectionUrl: "https://resumed.upstash.app",
            }),
          getStatus: (providerSandboxId) =>
            Effect.succeed({ providerSandboxId, state: "running" as const }),
          destroy: () => Effect.void,
          getPublicUrl: () => Effect.succeed("https://public.upstash.app"),
        });

        const testLayer = SandboxOrchestratorService.layer.pipe(
          Layer.provide(SandboxRepository.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(
            layerSandboxProviderRegistry([
              { provider: "codesandbox", driver: null, defaultSnapshotId: null },
              { provider: "upstash-box", driver: fakeDriver, defaultSnapshotId: null },
              { provider: "vercel-sandbox", driver: null, defaultSnapshotId: null },
            ]),
          ),
          Layer.provide(
            Layer.succeed(
              SandboxConfig,
              SandboxConfig.of({
                defaultIdleTimeoutMinutes: 8,
                codesandboxApiKey: Option.none(),
                upstashBoxApiKey: Option.some(Redacted.make("upstash_secret")),
                vercelOidcToken: Option.none(),
                vercelToken: Option.none(),
                vercelTeamId: Option.none(),
                vercelProjectId: Option.none(),
                defaultSnapshots: { codesandbox: null, upstashBox: null, vercelSandbox: null },
                passthroughSecrets: { PRIME_API_KEY: Redacted.make("prime_secret") },
              }),
            ),
          ),
          Layer.provide(NodeCrypto.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* SandboxOrchestratorService.SandboxOrchestratorService;

          const spawned = yield* orchestrator.spawnSandbox({
            provider: "upstash-box",
            name: "dev-box",
            repoUrl: "https://github.com/org/repo.git",
            branch: "main",
            agentHarness: "prime-agent",
            createBaseSnapshot: true,
          });

          expect(spawned.sandbox.state).toBe("running");
          expect(spawned.sandbox.idleTimeoutMinutes).toBe(8);
          expect(spawned.sandbox.baseSnapshotId).toBe("snap-1");
          expect(spawned.sandbox.connectionUrl).toBe("https://public.upstash.app");
          expect(spawned.sandbox.environmentId).toBe("env-cloud-1");
          expect(spawned.pairingUrl).toBe("https://public.upstash.app/pair#token=abc123");

          // Verify cloud machine kind + secret passthrough + headless serve launch
          const serverStart = execLog.find((entry) => entry.detached === true);
          expect(serverStart?.command).toContain("T3CODE_ENVIRONMENT_MACHINE_KIND=cloud");
          expect(serverStart?.command).toContain("serve --host 0.0.0.0 --port 3773 --no-browser");
          expect(serverStart?.command).not.toContain("--lan");
          expect(serverStart?.env?.PRIME_API_KEY).toBe("prime_secret");
          const cloneExec = execLog.find((entry) => entry.command.includes("git $GIT_AUTH clone"));
          expect(cloneExec?.command).toContain("\n");
          expect(cloneExec?.command).toContain("credential.helper");
          const pairExec = execLog.find((entry) => entry.command.includes("$CLI pair"));
          expect(pairExec?.command).toBeDefined();
          expect(pairExec?.command).not.toContain("--url");

          const snap = yield* orchestrator.snapshotSandbox({
            id: spawned.sandbox.id,
            name: "manual-cp",
          });
          expect(snap.snapshotId).toBe("snap-2");
          expect(snap.sandbox.snapshotId).toBe("snap-2");

          const stopped = yield* orchestrator.stopSandbox({ id: spawned.sandbox.id });
          expect(stopped.sandbox.state).toBe("paused");

          const resumed = yield* orchestrator.resumeSandbox({ id: spawned.sandbox.id });
          expect(resumed.sandbox.state).toBe("running");
          expect(resumed.sandbox.pausedAt).toBeNull();

          const listed = yield* orchestrator.listSandboxes();
          expect(listed.sandboxes).toHaveLength(1);
          expect(listed.defaultIdleTimeoutMinutes).toBe(8);

          yield* orchestrator.destroySandbox({ id: spawned.sandbox.id });
          expect((yield* orchestrator.listSandboxes()).sandboxes).toHaveLength(0);
        }).pipe(Effect.provide(testLayer));
      }),
  );

  it("extractPairingUrl prefers the labeled Pairing URL line with #token= over line-1 origin", () => {
    const cliOutput = [
      "Pairing with KBCode (http://127.0.0.1:3773).",
      "",
      "Pairing URL: http://127.0.0.1:3773/pair#token=secret_tok_99",
      "App link: kbcode://pair?url=http%3A%2F%2F127.0.0.1%3A3773%2Fpair%23token%3Dsecret_tok_99",
    ].join("\n");
    expect(extractPairingUrl(cliOutput)).toBe("http://127.0.0.1:3773/pair#token=secret_tok_99");
  });

  it("buildRepoCloneCommand emits valid newline-separated POSIX shell with GitHub token auth", () => {
    const cmd = buildRepoCloneCommand("https://github.com/KB01111/t3code.git", "main");
    expect(cmd.split("\n")[0]).toBe("set -eu");
    expect(cmd).toContain("credential.helper");
    expect(cmd).toContain("git $GIT_AUTH clone --depth 1 --branch 'main'");
  });

  it.effect("collectHostOAuthSyncPayload returns null command for empty directory", () =>
    Effect.gen(function* () {
      const empty = yield* collectHostOAuthSyncPayload("/nonexistent-kbcode-home-dir");
      expect(empty.command).toBeNull();
      expect(empty.env).toEqual({});
    }),
  );
});
