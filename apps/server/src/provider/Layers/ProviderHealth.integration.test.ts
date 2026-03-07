/**
 * Integration test for ProviderHealth against actual Auggie CLI.
 *
 * Run with: bun run vitest run src/provider/Layers/ProviderHealth.integration.test.ts
 *
 * Prerequisites:
 * - Auggie CLI installed and available on PATH
 * - Auggie authenticated (run `auggie login` first)
 */

import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { checkAugmentProviderStatus } from "./ProviderHealth.ts";

describe("ProviderHealth Integration", () => {
  it("should detect Auggie CLI status", async () => {
    const program = Effect.gen(function* () {
      const status = yield* checkAugmentProviderStatus;

      console.log("Augment provider status:", JSON.stringify(status, null, 2));

      expect(status.provider).toBe("augment");
      expect(status.checkedAt).toBeDefined();

      // If Auggie is installed, it should be available
      if (status.available) {
        expect(status.status).toMatch(/ready|warning|error/);
        // If authenticated, should be ready
        if (status.authStatus === "authenticated") {
          expect(status.status).toBe("ready");
        }
      } else {
        expect(status.status).toBe("error");
        expect(status.message).toBeDefined();
      }

      return status;
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(NodeServices.layer)),
    );

    // Since we know Auggie is installed, verify it's available
    expect(result.available).toBe(true);
    // Status should be ready (may not be able to verify auth without actually starting a session)
    expect(result.status).toBe("ready");
  }, 30_000);
});

