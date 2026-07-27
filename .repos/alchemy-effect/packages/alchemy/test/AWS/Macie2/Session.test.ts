import * as AWS from "@/AWS";
import { Session } from "@/AWS/Macie2/Session.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as macie2 from "@distilled.cloud/aws/macie2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeMacie2TestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const testLease = makeMacie2TestLease();

// Lease acquisition may queue behind the complete lifecycle of every other
// Macie file. This does not widen any cloud-operation polling budget.
beforeAll(testLease.acquire, { timeout: 3_600_000 });
afterAll(testLease.release);

// `getMacieSession` throws `AccessDeniedException` ("Macie is not enabled")
// when the account has no session.
const getSession = macie2.getMacieSession({}).pipe(
  Effect.map((s) => s as macie2.GetMacieSessionResponse | undefined),
  Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

// The Macie session is an account/region singleton. This test only runs when
// Macie is not already enabled — it must never disable a session the user
// already operates (capture-and-restore safety).
test.provider(
  "lifecycle: enable Macie, update frequency, disable",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* getSession;
      if (preexisting) {
        yield* Effect.logInfo(
          "Macie already enabled — skipping destructive lifecycle test",
        );
        return;
      }

      yield* stack.destroy();

      // Create — enable Macie with six-hour publishing.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Session("Macie", {
            status: "ENABLED",
            findingPublishingFrequency: "SIX_HOURS",
          });
        }),
      );
      expect(created.status).toBe("ENABLED");
      expect(created.findingPublishingFrequency).toBe("SIX_HOURS");

      // Out-of-band verification.
      const live = yield* macie2.getMacieSession({});
      expect(live.status).toBe("ENABLED");
      expect(live.findingPublishingFrequency).toBe("SIX_HOURS");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Session);
      const all = yield* provider.list();
      expect(all.some((s) => s.status === "ENABLED")).toBe(true);

      // Update — change frequency + pause in place (no replacement).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Session("Macie", {
            status: "PAUSED",
            findingPublishingFrequency: "FIFTEEN_MINUTES",
          });
        }),
      );
      expect(updated.accountId).toBe(created.accountId);
      const afterUpdate = yield* macie2.getMacieSession({});
      expect(afterUpdate.status).toBe("PAUSED");
      expect(afterUpdate.findingPublishingFrequency).toBe("FIFTEEN_MINUTES");

      // Destroy — Macie is disabled and the account is unenrolled.
      yield* stack.destroy();
      const after = yield* getSession;
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
