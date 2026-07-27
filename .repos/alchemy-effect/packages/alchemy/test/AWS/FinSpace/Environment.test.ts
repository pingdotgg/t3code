import * as AWS from "@/AWS";
import { Environment } from "@/AWS/FinSpace";
import * as Test from "@/Test/Alchemy";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as finspaceData from "@distilled.cloud/aws/finspace-data";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag the Environment provider's read/delete paths depend on.
// (environmentId must match ^[a-zA-Z0-9]{1,26}$ — malformed ids fail earlier
// with ValidationException.)
test.provider(
  "getEnvironment on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getEnvironment({
          environmentId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Ungated typed-error probe for the finspace-data (data-plane) SDK. The data
// API is environment-scoped and this account has no FinSpace environment, so
// it rejects with a plain-text 403 body ("Failed to retrieve environment").
// This proves the distilled rest-json fallback turns that into the typed
// AccessDeniedException instead of a ParseError.
test.provider(
  "finspace-data getDataset without an environment fails with AccessDeniedException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspaceData.getDataset({ datasetId: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }),
      );
      expect(error._tag).toBe("AccessDeniedException");
    }),
);

// Deletion is verified as INITIATED (irreversible) or fully gone — full
// disappearance takes many more minutes server-side.
const assertEnvironmentDeleting = (environmentId: string) =>
  Effect.gen(function* () {
    const status = yield* finspace.getEnvironment({ environmentId }).pipe(
      Effect.map((r) => r.environment?.status ?? "gone"),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (
      status !== "gone" &&
      status !== "DELETED" &&
      status !== "DELETING" &&
      status !== "DELETE_REQUESTED"
    ) {
      return yield* Effect.fail(
        new Error(`environment '${environmentId}' still exists (${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// A FinSpace environment takes ~20 minutes to provision, bills while it
// exists, and FinSpace is closed to non-onboarded accounts. The full
// lifecycle is gated behind AWS_TEST_FINSPACE=1 and always destroys what it
// created.
test.provider.skipIf(!process.env.AWS_TEST_FINSPACE)(
  "create FinSpace environment, verify, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { env } = yield* stack.deploy(
        Effect.gen(function* () {
          const env = yield* Environment("Analytics", {
            description: "alchemy finspace test environment",
            tags: { fixture: "finspace-environment" },
          });
          return { env };
        }),
      );

      expect(env.environmentId).toBeDefined();
      expect(env.environmentArn).toContain(":environment/");
      expect(env.status).toBe("CREATED");
      expect(env.tags.fixture).toBe("finspace-environment");

      // Out-of-band verification via distilled.
      const observed = yield* finspace.getEnvironment({
        environmentId: env.environmentId,
      });
      expect(observed.environment?.status).toBe("CREATED");
      expect(observed.environment?.name).toBe(env.name);

      // Update the description in place (no replacement).
      const { env: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const env = yield* Environment("Analytics", {
            description: "alchemy finspace test environment (updated)",
            tags: { fixture: "finspace-environment" },
          });
          return { env };
        }),
      );
      expect(updated.environmentId).toBe(env.environmentId);

      // Destroy immediately — environments bill while they exist — and
      // verify deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertEnvironmentDeleting(env.environmentId);
    }),
  // environment create (~20 min) + update + delete, one test.
  { timeout: 3_000_000 },
);
