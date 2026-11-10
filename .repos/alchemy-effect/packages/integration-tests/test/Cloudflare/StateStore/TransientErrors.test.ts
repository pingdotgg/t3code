import { EdgeSessionError } from "@alchemy.run/cloudflare/EdgeSession";
import { isTransientEdgeSessionError } from "@alchemy.run/cloudflare/StateStore/State";
import { describe, expect, it } from "@alchemy.run/test";

/**
 * Predicate coverage for the edge-preview secret-read retry policy, added in
 * response to production failures (Axiom `prod-traces`): reads failing with
 * Cloudflare HTML error pages ("Secret probe returned 400/502:
 * <!DOCTYPE html>..."), session creation flakes and transport errors
 * ("fetch failed").
 */
describe(
  "isTransientEdgeSessionError",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it("retries non-200 secret-probe responses (Cloudflare HTML error pages)", () => {
      const error = new EdgeSessionError({
        message: 'Secret probe returned 400: <!DOCTYPE html>\n<html class="no-',
      });
      expect(isTransientEdgeSessionError(error)).toBe(true);
    });

    it("retries session-creation failures with transient causes", () => {
      const error = new EdgeSessionError({
        message: "Failed to create edge preview session",
        cause: new TypeError("fetch failed"),
      });
      expect(isTransientEdgeSessionError(error)).toBe(true);
    });

    it("does not retry permanent auth causes", () => {
      for (const tag of ["Unauthorized", "Forbidden", "InvalidRoute"]) {
        const cause = Object.assign(new Error("denied"), { _tag: tag });
        const error = new EdgeSessionError({
          message: "Failed to create edge preview session",
          cause,
        });
        expect(isTransientEdgeSessionError(error)).toBe(false);
      }
    });

    it("ignores non-EdgeSessionError values", () => {
      expect(isTransientEdgeSessionError(new Error("boom"))).toBe(false);
    });
  },
);
