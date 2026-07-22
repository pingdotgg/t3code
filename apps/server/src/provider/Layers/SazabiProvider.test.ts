import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SazabiSettings, SAZABI_TOKEN_ENV_VAR } from "@t3tools/contracts";

import {
  buildInitialSazabiProviderSnapshot,
  checkSazabiProviderStatus,
  resolveSazabiToken,
  SAZABI_MISSING_AUTH_MESSAGE,
} from "./SazabiProvider.ts";

const decodeSazabiSettings = Schema.decodeSync(SazabiSettings);

// Deterministic environments — never fall back to the host `process.env` so a
// developer's real SAZABI_TOKEN can't flip these assertions.
const ENV_NO_TOKEN: NodeJS.ProcessEnv = {};
const ENV_WITH_TOKEN: NodeJS.ProcessEnv = { [SAZABI_TOKEN_ENV_VAR]: "sazabi-test-token" };

describe("resolveSazabiToken", () => {
  it("returns undefined when the token is unset or blank", () => {
    expect(resolveSazabiToken({})).toBeUndefined();
    expect(resolveSazabiToken({ [SAZABI_TOKEN_ENV_VAR]: "   " })).toBeUndefined();
  });

  it("returns the trimmed token when present", () => {
    expect(resolveSazabiToken({ [SAZABI_TOKEN_ENV_VAR]: "  abc  " })).toBe("abc");
  });
});

describe("buildInitialSazabiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialSazabiProviderSnapshot(
        decodeSazabiSettings({ enabled: false }),
        ENV_NO_TOKEN,
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("reflects a missing token as not-yet-installed while checking", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialSazabiProviderSnapshot(
        decodeSazabiSettings({ enabled: true }),
        ENV_NO_TOKEN,
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("Checking Sazabi");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["sazabi-default"]);
    }),
  );

  it.effect("optimistically marks token auth before the probe runs", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialSazabiProviderSnapshot(
        decodeSazabiSettings({ enabled: true }),
        ENV_WITH_TOKEN,
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.auth.type).toBe("token");
      expect(snapshot.auth.label).toBe(SAZABI_TOKEN_ENV_VAR);
    }),
  );
});

it.layer(NodeServices.layer)("checkSazabiProviderStatus", (it) => {
  it.effect("is unavailable with a clear reason when no token and no CLI are configured", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkSazabiProviderStatus(
        decodeSazabiSettings({ enabled: true }),
        ENV_NO_TOKEN,
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toBe(SAZABI_MISSING_AUTH_MESSAGE);
    }),
  );

  it.effect("reports ready + authenticated when SAZABI_TOKEN is present", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkSazabiProviderStatus(
        decodeSazabiSettings({ enabled: true }),
        ENV_WITH_TOKEN,
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBeNull();
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.auth.type).toBe("token");
      expect(snapshot.auth.label).toBe(SAZABI_TOKEN_ENV_VAR);
    }),
  );

  it.effect(
    "is unavailable when the optional CLI path cannot be resolved and no token is set",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* checkSazabiProviderStatus(
          decodeSazabiSettings({
            enabled: true,
            binaryPath: "/definitely/not/installed/sazabi-binary",
          }),
          ENV_NO_TOKEN,
        );
        expect(snapshot.enabled).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toMatch(/unauthenticated|unknown/);
        expect(snapshot.message).toMatch(/unavailable|Failed to execute/);
      }),
  );

  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkSazabiProviderStatus(
        decodeSazabiSettings({ enabled: false }),
        ENV_WITH_TOKEN,
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );
});
