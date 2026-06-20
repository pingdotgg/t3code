import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  loadPreviewWebviewConfig,
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
} from "./previewWebviewConfigState";

const environmentId = EnvironmentId.make("environment-1");

describe("loadPreviewWebviewConfig", () => {
  it.effect("reports a structurally distinct missing-bridge failure", () =>
    Effect.gen(function* () {
      const error = yield* loadPreviewWebviewConfig(environmentId, null).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewWebviewBridgeUnavailableError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.message).toContain(environmentId);
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves the bridge rejection as the load failure cause", () =>
    Effect.gen(function* () {
      const cause = new Error("ipc unavailable");
      const error = yield* loadPreviewWebviewConfig(environmentId, {
        getPreviewConfig: () => Promise.reject(cause),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewWebviewConfigLoadError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.cause).toBe(cause);
      expect(error.message).not.toContain(cause.message);
    }),
  );

  it.effect("forwards the environment id to the bridge", () =>
    Effect.gen(function* () {
      let requestedEnvironmentId: EnvironmentId | null = null;
      const config = {
        partition: "persist:test-preview",
        webPreferences: "sandbox=yes",
        preloadUrl: null,
      };
      const result = yield* loadPreviewWebviewConfig(environmentId, {
        getPreviewConfig: (input) => {
          requestedEnvironmentId = input;
          return Promise.resolve(config);
        },
      });

      expect(requestedEnvironmentId).toBe(environmentId);
      expect(result).toEqual(config);
    }),
  );
});
