import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  loadPreviewWebviewConfig,
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
} from "./previewWebviewConfigState";

const environmentId = EnvironmentId.make("environment-1");

describe("loadPreviewWebviewConfig", () => {
  it("reports a structurally distinct missing-bridge failure", async () => {
    const error = await Effect.runPromise(
      loadPreviewWebviewConfig(environmentId, null).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(PreviewWebviewBridgeUnavailableError);
    expect(error.environmentId).toBe(environmentId);
    expect(error.message).toContain(environmentId);
    expect("cause" in error).toBe(false);
  });

  it("preserves the bridge rejection as the load failure cause", async () => {
    const cause = new Error("ipc unavailable");
    const error = await Effect.runPromise(
      loadPreviewWebviewConfig(environmentId, {
        getPreviewConfig: () => Promise.reject(cause),
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(PreviewWebviewConfigLoadError);
    expect(error.environmentId).toBe(environmentId);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(cause.message);
  });

  it("forwards the environment id to the bridge", async () => {
    let requestedEnvironmentId: EnvironmentId | null = null;
    const config = {
      partition: "persist:test-preview",
      webPreferences: "sandbox=yes",
      preloadUrl: null,
    };
    const result = await Effect.runPromise(
      loadPreviewWebviewConfig(environmentId, {
        getPreviewConfig: (input) => {
          requestedEnvironmentId = input;
          return Promise.resolve(config);
        },
      }),
    );

    expect(requestedEnvironmentId).toBe(environmentId);
    expect(result).toEqual(config);
  });
});
