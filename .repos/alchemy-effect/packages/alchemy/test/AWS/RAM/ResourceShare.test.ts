import * as AWS from "@/AWS";
import { ResourceShare } from "@/AWS/RAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ram from "@distilled.cloud/aws/ram";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A well-known AWS documentation placeholder account ID; not assigned to any
// real account, so sharing to it is inert but exercises the PRINCIPAL path.
const EXTERNAL_PRINCIPAL = "123456789012";

class ShareStillLive extends Data.TaggedError("ShareStillLive") {}
class PrincipalStillAssociated extends Data.TaggedError(
  "PrincipalStillAssociated",
) {}

const readShare = Effect.fn(function* (arn: string) {
  const shares = yield* ram
    .getResourceShares({ resourceOwner: "SELF", resourceShareArns: [arn] })
    .pipe(
      Effect.map((r) => r.resourceShares ?? []),
      Effect.catchTag("UnknownResourceException", () => Effect.succeed([])),
    );
  return shares.find(
    (s) =>
      s.resourceShareArn === arn &&
      s.status !== "DELETING" &&
      s.status !== "DELETED",
  );
});

const readPrincipals = Effect.fn(function* (arn: string) {
  const associations = yield* ram
    .getResourceShareAssociations({
      resourceShareArns: [arn],
      associationType: "PRINCIPAL",
    })
    .pipe(
      Effect.map((r) => r.resourceShareAssociations ?? []),
      Effect.catchTag("UnknownResourceException", () => Effect.succeed([])),
    );
  return associations
    .filter((a) => a.status === "ASSOCIATED" || a.status === "ASSOCIATING")
    .map((a) => a.associatedEntity);
});

const assertDeleted = Effect.fn(function* (arn: string) {
  yield* readShare(arn).pipe(
    Effect.flatMap((s) =>
      s === undefined ? Effect.void : Effect.fail(new ShareStillLive()),
    ),
    Effect.retry({
      while: (e) => e instanceof ShareStillLive,
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(15)]),
    }),
  );
});

const shareStack = (props: {
  principals?: string[];
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const share = yield* ResourceShare("TestShare", {
      allowExternalPrincipals: true,
      principals: props.principals,
      tags: props.tags,
    });
    return { share };
  });

test.provider(
  "create, associate principal, update tags, disassociate, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Create with an external principal + tags.
      const { share } = yield* stack.deploy(
        shareStack({
          principals: [EXTERNAL_PRINCIPAL],
          tags: { team: "platform" },
        }),
      );

      expect(share.resourceShareArn).toMatch(/^arn:aws:ram:/);
      expect(share.allowExternalPrincipals).toBe(true);
      const arn = share.resourceShareArn;

      // 2. Out-of-band: the share is ACTIVE with our tags.
      const live = yield* readShare(arn);
      expect(live?.resourceShareArn).toEqual(arn);
      expect(live?.allowExternalPrincipals).toBe(true);
      expect(
        live?.tags?.some((t) => t.key === "team" && t.value === "platform"),
      ).toBe(true);
      expect(live?.tags?.some((t) => t.key === "alchemy::id")).toBe(true);

      // 3. Out-of-band: the PRINCIPAL association exists (may still be
      //    ASSOCIATING immediately after create).
      yield* Effect.gen(function* () {
        const principals = yield* readPrincipals(arn);
        expect(principals).toContain(EXTERNAL_PRINCIPAL);
      }).pipe(
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(10),
          ]),
        }),
      );

      // 4. Update in place: drop the principal, add a tag. ARN is stable.
      const { share: updated } = yield* stack.deploy(
        shareStack({
          principals: [],
          tags: { team: "platform", env: "prod" },
        }),
      );
      expect(updated.resourceShareArn).toEqual(arn);

      // 5. Out-of-band: new tag present, principal disassociated.
      const live2 = yield* readShare(arn);
      expect(
        live2?.tags?.some((t) => t.key === "env" && t.value === "prod"),
      ).toBe(true);

      yield* readPrincipals(arn).pipe(
        Effect.flatMap((principals) =>
          principals.includes(EXTERNAL_PRINCIPAL)
            ? Effect.fail(new PrincipalStillAssociated())
            : Effect.void,
        ),
        Effect.retry({
          while: (e) => e instanceof PrincipalStillAssociated,
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(12),
          ]),
        }),
      );

      // 6. Delete and confirm gone.
      yield* stack.destroy();
      yield* assertDeleted(arn);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed resource share",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { share } = yield* stack.deploy(shareStack({}));

      const provider = yield* Provider.findProvider(ResourceShare);
      const all = yield* provider.list();
      expect(
        all.some((x) => x.resourceShareArn === share.resourceShareArn),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertDeleted(share.resourceShareArn);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
