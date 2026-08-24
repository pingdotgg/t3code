import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const retryForbidden = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// `list()` fans out across account BYOIP prefixes (`listPrefixes`) and lists
// each prefix's service bindings (`listPrefixServiceBindings`). Both endpoints
// are available regardless of the BYOIP entitlement — on an account with no
// onboarded prefixes the result is an empty, well-typed
// `ServiceBindingAttributes[]` (the exact shape `read` produces).
test.provider(
  "list enumerates service bindings across prefixes (read-only)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Addressing.ServiceBinding,
      );
      const all = yield* retryForbidden(provider.list());

      expect(Array.isArray(all)).toBe(true);
      for (const b of all) {
        expect(typeof b.bindingId).toBe("string");
        expect(typeof b.prefixId).toBe("string");
        expect(typeof b.accountId).toBe("string");
        expect(typeof b.cidr).toBe("string");
        expect(typeof b.serviceId).toBe("string");
        expect(typeof b.provisioning).toBe("object");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
);
