import * as ecs from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";

/**
 * Fully reclaim every revision of an out-of-band task definition family:
 * deregister any ACTIVE revisions, then hard-delete the INACTIVE revisions
 * via `deleteTaskDefinitions` (deregistering alone leaves them INACTIVE,
 * which still shows up in a live `listTaskDefinitions --status INACTIVE`
 * sweep).
 *
 * Idempotent — run it BEFORE a test to recover leftovers from a previously
 * killed run (the family names are deterministic, so a re-run reclaims a
 * prior orphan instead of stacking new revisions forever), and as a
 * finalizer AFTER the test so a passing test leaves zero task definitions
 * behind.
 */
export const reclaimTaskDefinitionFamily = (family: string) =>
  Effect.gen(function* () {
    // `familyPrefix` is a prefix match — filter to the exact family so a
    // family that happens to prefix another test's family is untouched.
    const list = (status: "ACTIVE" | "INACTIVE") =>
      ecs
        .listTaskDefinitions({ familyPrefix: family, status })
        .pipe(
          Effect.map((r) =>
            (r.taskDefinitionArns ?? []).filter((arn) =>
              arn.includes(`/${family}:`),
            ),
          ),
        );

    const active = yield* list("ACTIVE");
    yield* Effect.forEach(active, (arn) =>
      ecs
        .deregisterTaskDefinition({ taskDefinition: arn })
        .pipe(Effect.catchTag("ClientException", () => Effect.void)),
    );

    const inactive = yield* list("INACTIVE");
    // deleteTaskDefinitions accepts at most 10 ARNs per call.
    for (let i = 0; i < inactive.length; i += 10) {
      yield* ecs
        .deleteTaskDefinitions({ taskDefinitions: inactive.slice(i, i + 10) })
        .pipe(Effect.catchTag("ClientException", () => Effect.void));
    }
  });
