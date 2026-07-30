import * as AWS from "@/AWS";
import { AllowList } from "@/AWS/Macie2/AllowList.ts";
import { CustomDataIdentifier } from "@/AWS/Macie2/CustomDataIdentifier.ts";
import { FindingsFilter } from "@/AWS/Macie2/FindingsFilter.ts";
import { Session } from "@/AWS/Macie2/Session.ts";
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

// AllowList, CustomDataIdentifier, and FindingsFilter all require Macie to be
// enabled. To avoid touching a Macie session the user already operates
// (capture-and-restore safety), the test only runs when Macie is not already
// enabled — it enables Macie itself and disables it again on destroy.
test.provider(
  "lifecycle: allow list + custom data identifier + findings filter",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* getSession;
      if (preexisting) {
        yield* Effect.logInfo(
          "Macie already enabled — skipping Macie2 resources lifecycle test",
        );
        return;
      }

      yield* stack.destroy();

      // Phase 1 — enable Macie and create all three resources.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Session("Macie", { status: "ENABLED" });
          const allowList = yield* AllowList("Ignore", {
            description: "internal ticket ids",
            criteria: { regex: "TICKET-[0-9]{6}" },
            tags: { env: "test" },
          });
          const identifier = yield* CustomDataIdentifier("EmployeeId", {
            regex: "EMP-[0-9]{8}",
            description: "internal employee id",
            tags: { env: "test" },
          });
          const filter = yield* FindingsFilter("LowSeverity", {
            action: "ARCHIVE",
            position: 1,
            findingCriteria: {
              criterion: { "severity.description": { eq: ["Low"] } },
            },
            tags: { env: "test" },
          });
          return {
            allowListId: allowList.id,
            allowListArn: allowList.arn,
            identifierId: identifier.id,
            identifierArn: identifier.arn,
            filterId: filter.id,
            filterAction: filter.action,
          };
        }),
      );
      expect(created.allowListId).toBeTruthy();
      expect(created.allowListArn).toContain(":allow-list/");
      expect(created.identifierArn).toContain(":custom-data-identifier/");
      expect(created.filterAction).toBe("ARCHIVE");

      // Out-of-band verification (including Alchemy ownership tags).
      const liveAllow = yield* macie2.getAllowList({
        id: created.allowListId,
      });
      expect(liveAllow.criteria?.regex).toBe("TICKET-[0-9]{6}");
      expect(liveAllow.tags?.["env"]).toBe("test");
      expect(liveAllow.tags?.["alchemy::id"]).toBe("Ignore");

      const liveIdentifier = yield* macie2.getCustomDataIdentifier({
        id: created.identifierId,
      });
      expect(liveIdentifier.regex).toBe("EMP-[0-9]{8}");
      expect(liveIdentifier.tags?.["alchemy::id"]).toBe("EmployeeId");

      const liveFilter = yield* macie2.getFindingsFilter({
        id: created.filterId,
      });
      expect(liveFilter.action).toBe("ARCHIVE");
      expect(
        liveFilter.findingCriteria?.criterion?.["severity.description"]?.eq,
      ).toEqual(["Low"]);

      // Phase 2 — in-place updates (allow list criteria + filter action/tags)
      // and a replacement (custom data identifiers are immutable, so a regex
      // change swaps the physical identifier).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Session("Macie", { status: "ENABLED" });
          const allowList = yield* AllowList("Ignore", {
            description: "internal ticket ids v2",
            criteria: { regex: "TICKET-[0-9]{7}" },
            tags: { env: "test" },
          });
          const identifier = yield* CustomDataIdentifier("EmployeeId", {
            regex: "EMP-[0-9]{9}",
            description: "internal employee id",
            tags: { env: "test" },
          });
          const filter = yield* FindingsFilter("LowSeverity", {
            action: "NOOP",
            position: 1,
            findingCriteria: {
              criterion: { "severity.description": { eq: ["Low"] } },
            },
            tags: { env: "test", phase: "two" },
          });
          return {
            allowListId: allowList.id,
            identifierId: identifier.id,
            filterId: filter.id,
          };
        }),
      );

      // Allow list + filter update in place; the identifier is replaced.
      expect(updated.allowListId).toBe(created.allowListId);
      expect(updated.filterId).toBe(created.filterId);
      expect(updated.identifierId).not.toBe(created.identifierId);

      const updatedAllow = yield* macie2.getAllowList({
        id: updated.allowListId,
      });
      expect(updatedAllow.criteria?.regex).toBe("TICKET-[0-9]{7}");
      expect(updatedAllow.description).toBe("internal ticket ids v2");

      const updatedFilter = yield* macie2.getFindingsFilter({
        id: updated.filterId,
      });
      expect(updatedFilter.action).toBe("NOOP");
      expect(updatedFilter.tags?.["phase"]).toBe("two");

      const updatedIdentifier = yield* macie2.getCustomDataIdentifier({
        id: updated.identifierId,
      });
      expect(updatedIdentifier.regex).toBe("EMP-[0-9]{9}");
      // The replaced identifier is soft-deleted.
      const replaced = yield* macie2.getCustomDataIdentifier({
        id: created.identifierId,
      });
      expect(replaced.deleted).toBe(true);

      // Destroy — every resource is removed and Macie is disabled (which
      // also proves delete-idempotence via the AccessDenied catch: the
      // session delete may land before the sub-resource deletes re-check).
      yield* stack.destroy();
      const after = yield* getSession;
      expect(after).toBeUndefined();
    }),
  { timeout: 300_000 },
);
