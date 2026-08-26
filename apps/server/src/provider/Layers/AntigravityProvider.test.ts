import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

  it.effect("probes agy binary status and detects installed CLI and skills", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeAntigravitySettings({ enabled: true }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBeTruthy();
      expect(snapshot.skills.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
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

  it.effect("sends a turn through AntigravityAdapter and receives completion", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAntigravityAdapter(decodeAntigravitySettings({}));
      const threadId = ThreadId.make("test-antigravity-thread-turn");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turnResult = yield* adapter.sendTurn({
        threadId,
        input: "Reply with the single word 'ok'",
      });

      expect(turnResult.turnId).toBeTruthy();

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
