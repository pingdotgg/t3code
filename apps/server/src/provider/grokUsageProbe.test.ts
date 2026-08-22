import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  grokAuthFromSubscriptionProbe,
  grokHasUsageSubscription,
  parseGrokAuthCheckSubscription,
  probeGrokAuthViaAcp,
} from "./grokUsageProbe.ts";

describe("grokUsageProbe", () => {
  it("parses authenticated subscription probes", () => {
    expect(
      parseGrokAuthCheckSubscription({
        authenticated: true,
        meta: {
          email: "user@example.com",
          auth_mode: "Oidc",
          subscription_tier: "SuperGrok",
        },
      }),
    ).toEqual({
      authenticated: true,
      email: "user@example.com",
      authMode: "Oidc",
      subscriptionTier: "SuperGrok",
    });
  });

  it("parses unauthenticated subscription probes", () => {
    expect(parseGrokAuthCheckSubscription({ authenticated: false })).toEqual({
      authenticated: false,
    });
  });

  it("returns undefined for payloads without a boolean authenticated field", () => {
    expect(parseGrokAuthCheckSubscription({})).toBeUndefined();
    expect(parseGrokAuthCheckSubscription({ meta: { email: "user@example.com" } })).toBeUndefined();
    expect(parseGrokAuthCheckSubscription({ authenticated: "true" })).toBeUndefined();
  });

  it("maps authenticated probes to provider auth metadata", () => {
    expect(
      grokAuthFromSubscriptionProbe({
        authenticated: true,
        email: "user@example.com",
        subscriptionTier: "SuperGrok",
      }),
    ).toEqual({
      status: "authenticated",
      email: "user@example.com",
      type: "SuperGrok",
      label: "SuperGrok",
    });
  });

  it("only treats a paid Grok plan as having usage windows to probe", () => {
    expect(grokHasUsageSubscription(undefined)).toBe(false);
    expect(grokHasUsageSubscription({ authenticated: false })).toBe(false);
    expect(grokHasUsageSubscription({ authenticated: true })).toBe(false);
    expect(grokHasUsageSubscription({ authenticated: true, subscriptionTier: "Free" })).toBe(false);
    expect(grokHasUsageSubscription({ authenticated: true, subscriptionTier: "SuperGrok" })).toBe(
      true,
    );
  });

  it.effect("degrades ACP process-exit and decode defects to missing auth metadata", () =>
    Effect.gen(function* () {
      const processExit = yield* probeGrokAuthViaAcp({
        runtime: {
          request: () => Effect.fail(new EffectAcpErrors.AcpProcessExitedError({ code: 1 })),
        },
        sessionId: "session",
      });
      const defect = yield* probeGrokAuthViaAcp({
        runtime: {
          request: () => Effect.die("decode exploded"),
        },
        sessionId: "session",
      });

      expect(processExit).toBeUndefined();
      expect(defect).toBeUndefined();
    }),
  );

  it.effect("does not swallow interrupts while probing Grok auth", () =>
    Effect.gen(function* () {
      const exit = yield* probeGrokAuthViaAcp({
        runtime: {
          request: () => Effect.interrupt,
        },
        sessionId: "session",
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
    }),
  );
});
