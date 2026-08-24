import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildInitialOhMyPiProviderSnapshot,
  OH_MY_PI_MANAGED_MODEL,
} from "./OhMyPiProvider.ts";

describe("OhMyPiProvider", () => {
  it.effect("exposes OMP as one harness-managed model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOhMyPiProviderSnapshot({ enabled: true, binaryPath: "" });
      expect(snapshot.models).toHaveLength(1);
      expect(snapshot.models[0]?.slug).toBe(OH_MY_PI_MANAGED_MODEL);
      expect(snapshot.models[0]?.name).toBe("Oh My Pi (managed)");
    }),
  );
});
