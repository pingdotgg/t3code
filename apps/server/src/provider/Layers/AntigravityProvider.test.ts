import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AntigravitySettings, ThreadId } from "@t3tools/contracts";

import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
} from "./AntigravityProvider.ts";
import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

describe("buildInitialAntigravityProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({}),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns an enabled pending snapshot when enabled is true", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAntigravityProviderSnapshot(
        decodeAntigravitySettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models.length).toBeGreaterThan(0);
      expect(snapshot.models[0]?.slug).toBe("gemini-3.7-flash-high");
    }),
  );
});

describe("checkAntigravityProviderStatus", () => {
  it.effect("reports binary as missing when binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeAntigravitySettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/agy-missing-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports installed CLI as unhealthy when probe exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-test-" });
          const agyPath = path.join(dir, "agy");
          yield* fs.writeFileString(agyPath, ["#!/bin/sh", "exit 2", ""].join("\n"));
          yield* fs.chmod(agyPath, 0o755);

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer));

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Antigravity CLI is installed but failed to run.");
    }),
  );

  it.effect("reports ready status when agy is available and outputs version", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-valid-" });
          const agyPath = path.join(dir, "agy");
          yield* fs.writeFileString(agyPath, ["#!/bin/sh", "echo 1.2.3", "exit 0", ""].join("\n"));
          yield* fs.chmod(agyPath, 0o755);

          return yield* checkAntigravityProviderStatus(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer));

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.2.3");
    }),
  );
});

describe("AntigravityAdapter", () => {
  it.effect("starts and stops an Antigravity session cleanly", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({}));
      const threadId = ThreadId.make("test-antigravity-thread-1");
      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      expect(session.threadId).toBe(threadId);
      expect(session.status).toBe("ready");
      expect(session.provider).toBe("antigravity");

      const has = yield* adapter.hasSession(threadId);
      expect(has).toBe(true);

      yield* adapter.stopSession(threadId);
      const hasAfter = yield* adapter.hasSession(threadId);
      expect(hasAfter).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "sends a turn through AntigravityAdapter with scripted CLI and receives completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-adapter-" });
          const agyPath = path.join(dir, "agy");

          const script = [
            "#!/bin/sh",
            `echo "{\"event\":\"init\",\"conversation_id\":\"mock-conv-1\"}"`,
            `echo "{\"event\":\"step_update\",\"step_update\":{\"step_index\":1,\"step_type\":\"agent_response\",\"text_delta\":\"hello from mock\",\"state\":\"DONE\"}}"`,
            `echo "{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"conversation_id\":\"mock-conv-1\"}}"`,
            "exit 0",
            "",
          ].join("\n");
          yield* fs.writeFileString(agyPath, script);
          yield* fs.chmod(agyPath, 0o755);

          const adapter = yield* makeAntigravityAdapter(
            decodeAntigravitySettings({ enabled: true, binaryPath: agyPath }),
          );
          const threadId = ThreadId.make("test-antigravity-mock-turn");
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const turnResult = yield* adapter.sendTurn({
            threadId,
            input: "Hello test",
          });

          expect(turnResult.turnId).toBeTruthy();
          expect(turnResult.threadId).toBe(threadId);

          yield* adapter.stopSession(threadId);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
