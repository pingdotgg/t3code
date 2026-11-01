import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  clearOutbox: vi.fn<(environmentId: string) => Promise<void>>(),
  clearDrafts: vi.fn<(environmentId: string) => Promise<void>>(),
  clearComposerErrors: vi.fn(),
}));

vi.mock("../state/thread-outbox-removal", () => ({
  clearThreadOutboxEnvironment: harness.clearOutbox,
}));
vi.mock("../state/use-composer-drafts", () => ({
  clearComposerDraftsEnvironment: harness.clearDrafts,
}));
vi.mock("../state/thread-composer-error", () => ({
  clearThreadComposerErrorsForEnvironment: harness.clearComposerErrors,
}));

import * as EnvironmentOwnedDataCleanup from "./environment-owned-data-cleanup";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

describe("EnvironmentOwnedDataCleanup", () => {
  it.effect("waits for the other clears and logs a bounded warning when one rejects", () => {
    const warnings: Array<unknown> = [];
    let releaseDrafts = () => {};
    let draftsCleared = false;
    // The drafts clear finishes only after the outbox failure is logged.
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
      releaseDrafts();
    });
    return Effect.gen(function* () {
      harness.clearOutbox.mockRejectedValue(new Error("Some queued messages could not be read."));
      harness.clearDrafts.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseDrafts = resolve;
        }).then(() => {
          draftsCleared = true;
        }),
      );

      const cleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
      yield* cleanup.clear(ENVIRONMENT_ID);

      expect(draftsCleared).toBe(true);
      expect(warnings).toEqual([
        [
          "Could not clear mobile environment-owned data.",
          {
            environmentId: ENVIRONMENT_ID,
            operation: "outbox",
            errorType: "error",
            errorName: "Error",
            stack: expect.any(String),
          },
        ],
      ]);
    }).pipe(
      Effect.provide(EnvironmentOwnedDataCleanup.layer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });
});
