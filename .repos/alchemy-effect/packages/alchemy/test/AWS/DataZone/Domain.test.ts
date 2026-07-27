import * as AWS from "@/AWS";
import { Domain } from "@/AWS/DataZone";
import * as Test from "@/Test/Alchemy";
import * as datazone from "@distilled.cloud/aws/datazone";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// A deleted domain is reported by GetDomain as AccessDeniedException, not
// ResourceNotFoundException — DataZone checks domain-scoped auth before
// existence. Both mean "absent".
const findDomain = (identifier: string) =>
  datazone.getDomain({ identifier }).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
    Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
  );

class StillExists extends Data.TaggedError("StillExists")<{
  readonly what: string;
}> {}

// Domain deletion is asynchronous (typically ~1 minute) — poll until gone.
const assertDomainGone = (identifier: string) =>
  findDomain(identifier).pipe(
    Effect.flatMap((d) =>
      d === undefined || d.status === "DELETED" || d.status === "DELETING"
        ? Effect.void
        : Effect.fail(new StillExists({ what: `domain ${identifier}` })),
    ),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create domain with managed role, update description, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Deploy a domain (auto-created execution role).
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* Domain("TestDomain", {
            description: "alchemy datazone domain test",
            tags: { Environment: "test" },
          });
          return {
            domainId: domain.domainId,
            domainArn: domain.domainArn,
            name: domain.name,
            status: domain.status,
            portalUrl: domain.portalUrl,
            roleName: domain.roleName,
            domainExecutionRole: domain.domainExecutionRole,
          };
        }),
      );

      expect(result.domainId).toMatch(/^dzd/);
      expect(result.domainArn).toContain(":domain/");
      expect(result.status).toBe("AVAILABLE");

      // out-of-band: domain is AVAILABLE and tags are branded.
      const created = yield* findDomain(result.domainId);
      expect(created).toBeDefined();
      expect(created!.status).toBe("AVAILABLE");
      expect(created!.name).toBe(result.name);
      expect(created!.tags?.Environment).toBe("test");
      expect(created!.tags?.["alchemy::id"]).toBe("TestDomain");

      // out-of-band: the managed execution role exists.
      expect(result.roleName).toBeDefined();
      const role = yield* iam
        .getRole({ RoleName: result.roleName! })
        .pipe(Effect.map((r) => r.Role));
      expect(role.Arn).toBe(result.domainExecutionRole);
      expect(created!.domainExecutionRole).toBe(result.domainExecutionRole);

      // 2. Update the description — converges via updateDomain, same domain.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* Domain("TestDomain", {
            description: "alchemy datazone domain test (updated)",
            tags: { Environment: "test", Update: "yes" },
          });
          return { domainId: domain.domainId };
        }),
      );
      expect(updated.domainId).toBe(result.domainId);

      const observed = yield* findDomain(result.domainId);
      expect(observed!.description).toBe(
        "alchemy datazone domain test (updated)",
      );
      expect(observed!.tags?.Update).toBe("yes");

      // 3. Destroy — domain and managed role are removed.
      yield* stack.destroy();
      yield* assertDomainGone(result.domainId);

      const roleGone = yield* iam.getRole({ RoleName: result.roleName! }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NoSuchEntityException", () => Effect.succeed(true)),
      );
      expect(roleGone).toBe(true);
    }),
  { timeout: 480_000 },
);
