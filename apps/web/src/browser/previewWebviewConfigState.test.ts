import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  loadPreviewWebviewConfig,
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
} from "./previewWebviewConfigState";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

describe("loadPreviewWebviewConfig", () => {
  it.effect("reports a structurally distinct missing-bridge failure", () =>
    Effect.gen(function* () {
      const error = yield* loadPreviewWebviewConfig(environmentId, projectId, undefined, null).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(PreviewWebviewBridgeUnavailableError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.projectId).toBe(projectId);
      expect(error.message).toContain(environmentId);
      expect(error.message).toContain(projectId);
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves the bridge rejection as the load failure cause", () =>
    Effect.gen(function* () {
      const cause = new Error("ipc unavailable");
      const error = yield* loadPreviewWebviewConfig(environmentId, projectId, "work", {
        getPreviewConfig: () => Promise.reject(cause),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PreviewWebviewConfigLoadError);
      expect(error.environmentId).toBe(environmentId);
      expect(error.projectId).toBe(projectId);
      expect(error.cause).toBe(cause);
      expect(error.message).not.toContain(cause.message);
    }),
  );

  it.effect("forwards the environment, project, and profile ids to the bridge", () =>
    Effect.gen(function* () {
      let requested: {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
        readonly profileId?: string;
      } | null = null;
      const config = {
        partition: "persist:test-preview",
        webPreferences: "sandbox=yes",
        preloadUrl: null,
      };
      const result = yield* loadPreviewWebviewConfig(environmentId, projectId, "work", {
        getPreviewConfig: (input) => {
          requested = input;
          return Promise.resolve(config);
        },
      });

      expect(requested).toEqual({ environmentId, projectId, profileId: "work" });
      expect(result).toEqual(config);
    }),
  );
});
