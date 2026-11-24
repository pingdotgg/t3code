import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { desktopReadinessProof, isValidDesktopReadinessProof } from "./desktopReadinessProof.ts";

describe("desktop readiness proof", () => {
  it.effect("is valid only for the launch secret and challenge it was derived from", () =>
    Effect.gen(function* () {
      const proof = yield* desktopReadinessProof("launch-secret", "challenge-1");

      expect(yield* isValidDesktopReadinessProof("launch-secret", "challenge-1", proof)).toBe(true);
      expect(
        yield* isValidDesktopReadinessProof("launch-secret", "challenge-1", `${proof}\n`),
      ).toBe(true);
      expect(yield* isValidDesktopReadinessProof("launch-secret", "challenge-2", proof)).toBe(
        false,
      );
      expect(yield* isValidDesktopReadinessProof("other-secret", "challenge-1", proof)).toBe(false);
      expect(yield* isValidDesktopReadinessProof("launch-secret", "challenge-1", "{}")).toBe(false);
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );
});
