// @effect-diagnostics nodeBuiltinImport:off

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it as test } from "vite-plus/test";

import {
  applyDesktopShellEnvironmentSnapshot,
  requireDesktopTelemetryWriteProgress,
} from "./DesktopTelemetryReceiver.ts";

describe("DesktopTelemetryReceiver", () => {
  test.each([
    { platform: "darwin", discovered: true, applied: true, pending: false },
    { platform: "win32", discovered: true, applied: false, pending: true },
    { platform: "darwin", discovered: false, applied: true, pending: true },
  ])(
    "applies platform=$platform discovered=$discovered with pending=$pending",
    ({ platform, discovered, applied, pending }) => {
      const environment: NodeJS.ProcessEnv = {
        PATH: "/old/bin",
        JAVA_HOME: "/old/java",
        UNRELATED: "keep",
        T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
      };
      applyDesktopShellEnvironmentSnapshot(environment, "darwin", {
        version: 1,
        type: "shellEnvironment",
        platform,
        discovered,
        environment: { PATH: "/fresh/bin", JAVA_HOME: null },
      });
      expect(environment).toEqual({
        PATH: applied ? "/fresh/bin" : "/old/bin",
        ...(applied ? {} : { JAVA_HOME: "/old/java" }),
        UNRELATED: "keep",
        ...(pending ? { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" } : {}),
      });
    },
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});
