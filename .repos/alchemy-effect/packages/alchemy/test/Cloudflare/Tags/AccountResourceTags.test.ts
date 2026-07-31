import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as resourceTagging from "@distilled.cloud/cloudflare/resource-tagging";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic names — the same on every run (never Date.now()/random).
const KV_TITLE_CRUD = "alchemy-account-tags-crud";
const KV_TITLE_REPLACE_A = "alchemy-account-tags-replace-a";
const KV_TITLE_REPLACE_B = "alchemy-account-tags-replace-b";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, part of the distilled error union via patches) on the
// test's own out-of-band verification calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const getTags = (accountId: string, resourceId: string, resourceType: string) =>
  resourceTagging.getAccountTag({ accountId, resourceId, resourceType }).pipe(
    Effect.map((r) => r.tags as Record<string, string>),
    Effect.retry(forbiddenRetry),
  );

// Cloudflare reports untagged (and unknown) resources as an empty tag
// set — poll until the set is empty after destroy.
const expectTagsCleared = (
  accountId: string,
  resourceId: string,
  resourceType: string,
) =>
  getTags(accountId, resourceId, resourceType).pipe(
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: (tags) => Object.keys(tags).length === 0,
      times: 10,
    }),
    Effect.map((tags) => expect(tags).toEqual({})),
  );

test.provider("create, update, and clear tags on a KV namespace", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const v1 = yield* stack.deploy(
      Effect.gen(function* () {
        const kv = yield* Cloudflare.KV.Namespace("TagsKv", {
          title: KV_TITLE_CRUD,
        });
        const tags = yield* Cloudflare.Tags.AccountResourceTags("KvTags", {
          resourceType: "kv_namespace",
          resourceId: kv.namespaceId,
          tags: { env: "test", team: "alchemy" },
        }).pipe(adopt(true));
        return { kv, tags };
      }),
    );

    expect(v1.tags.accountId).toEqual(accountId);
    expect(v1.tags.resourceType).toEqual("kv_namespace");
    expect(v1.tags.resourceId).toEqual(v1.kv.namespaceId);
    expect(v1.tags.tags).toEqual({ env: "test", team: "alchemy" });
    expect(v1.tags.etag).toBeTruthy();

    const live = yield* getTags(accountId, v1.kv.namespaceId, "kv_namespace");
    expect(live).toEqual({ env: "test", team: "alchemy" });

    // In-place update — PUT replaces the full set: change `env`, drop
    // `team`, add `owner`.
    const v2 = yield* stack.deploy(
      Effect.gen(function* () {
        const kv = yield* Cloudflare.KV.Namespace("TagsKv", {
          title: KV_TITLE_CRUD,
        });
        const tags = yield* Cloudflare.Tags.AccountResourceTags("KvTags", {
          resourceType: "kv_namespace",
          resourceId: kv.namespaceId,
          tags: { env: "prod", owner: "qa" },
        }).pipe(adopt(true));
        return { kv, tags };
      }),
    );

    // Same target resource — not a replacement.
    expect(v2.kv.namespaceId).toEqual(v1.kv.namespaceId);
    expect(v2.tags.tags).toEqual({ env: "prod", owner: "qa" });

    const updated = yield* getTags(
      accountId,
      v2.kv.namespaceId,
      "kv_namespace",
    );
    expect(updated).toEqual({ env: "prod", owner: "qa" });

    yield* stack.destroy();

    yield* expectTagsCleared(accountId, v1.kv.namespaceId, "kv_namespace");
  }).pipe(logLevel),
);

test.provider("changing resourceId triggers replacement", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const a = yield* Cloudflare.KV.Namespace("KvA", {
          title: KV_TITLE_REPLACE_A,
        });
        const b = yield* Cloudflare.KV.Namespace("KvB", {
          title: KV_TITLE_REPLACE_B,
        });
        const tags = yield* Cloudflare.Tags.AccountResourceTags("ReplaceTags", {
          resourceType: "kv_namespace",
          resourceId: a.namespaceId,
          tags: { pinned: "yes" },
        }).pipe(adopt(true));
        return { a, b, tags };
      }),
    );

    expect(initial.tags.resourceId).toEqual(initial.a.namespaceId);
    const onA = yield* getTags(
      accountId,
      initial.a.namespaceId,
      "kv_namespace",
    );
    expect(onA).toEqual({ pinned: "yes" });

    // Repoint the tag set at namespace B — `(resourceType, resourceId)`
    // is the tag set's identity, so this is a replacement: B gets
    // tagged, and the old set on A is cleared by the replacement delete.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const a = yield* Cloudflare.KV.Namespace("KvA", {
          title: KV_TITLE_REPLACE_A,
        });
        const b = yield* Cloudflare.KV.Namespace("KvB", {
          title: KV_TITLE_REPLACE_B,
        });
        const tags = yield* Cloudflare.Tags.AccountResourceTags("ReplaceTags", {
          resourceType: "kv_namespace",
          resourceId: b.namespaceId,
          tags: { pinned: "yes" },
        }).pipe(adopt(true));
        return { a, b, tags };
      }),
    );

    expect(replaced.tags.resourceId).toEqual(replaced.b.namespaceId);
    expect(replaced.tags.resourceId).not.toEqual(initial.a.namespaceId);

    const onB = yield* getTags(
      accountId,
      replaced.b.namespaceId,
      "kv_namespace",
    );
    expect(onB).toEqual({ pinned: "yes" });

    // The old tag set on A was cleared as part of the replacement.
    yield* expectTagsCleared(accountId, replaced.a.namespaceId, "kv_namespace");

    yield* stack.destroy();

    yield* expectTagsCleared(accountId, replaced.b.namespaceId, "kv_namespace");
  }).pipe(logLevel),
);

test.provider(
  "adoption — existing tags error without adopt, take over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      // Normalize the baseline — clear any leftover tags on the account
      // from interrupted runs.
      yield* resourceTagging
        .deleteAccountTag({
          accountId,
          resourceId: accountId,
          resourceType: "account",
        })
        .pipe(Effect.retry(forbiddenRetry));

      // Tag the account out-of-band so the stack has no state of its own
      // for it — exactly the "tags already exist" scenario.
      const pre = yield* resourceTagging
        .putAccountTag({
          accountId,
          resourceId: accountId,
          resourceType: "account",
          tags: { "alchemy-adopt-probe": "pre-existing" },
        })
        .pipe(Effect.retry(forbiddenRetry));
      expect(pre.tags).toEqual({ "alchemy-adopt-probe": "pre-existing" });

      // Without `adopt`: tags carry no ownership markers, so the engine
      // cannot prove we created them and refuses to clobber the set.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Tags.AccountResourceTags("AccountTags", {
              resourceType: "account",
              resourceId: accountId,
              tags: { "alchemy-adopt-probe": "managed" },
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing tag
      // set and converges it to the desired tags.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Tags.AccountResourceTags("AccountTags", {
            resourceType: "account",
            resourceId: accountId,
            tags: { "alchemy-adopt-probe": "managed" },
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.tags).toEqual({ "alchemy-adopt-probe": "managed" });

      const live = yield* getTags(accountId, accountId, "account");
      expect(live).toEqual({ "alchemy-adopt-probe": "managed" });

      yield* stack.destroy();

      yield* expectTagsCleared(accountId, accountId, "account");
    }).pipe(logLevel),
);

const KV_TITLE_LIST = "alchemy-account-tags-list";

test.provider("list enumerates account-wide tagged resources", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const kv = yield* Cloudflare.KV.Namespace("ListKv", {
          title: KV_TITLE_LIST,
        });
        const tags = yield* Cloudflare.Tags.AccountResourceTags("ListTags", {
          resourceType: "kv_namespace",
          resourceId: kv.namespaceId,
          tags: { env: "list-test", team: "alchemy" },
        }).pipe(adopt(true));
        return { kv, tags };
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Tags.AccountResourceTags,
    );
    const all = yield* provider.list();

    const match = all.find(
      (x) =>
        x.resourceType === "kv_namespace" &&
        x.resourceId === deployed.kv.namespaceId,
    );
    expect(match).toBeDefined();
    expect(match?.accountId).toEqual(accountId);
    expect(match?.tags).toEqual({ env: "list-test", team: "alchemy" });
    expect(match?.etag).toBeTruthy();

    yield* stack.destroy();

    yield* expectTagsCleared(
      accountId,
      deployed.kv.namespaceId,
      "kv_namespace",
    );
  }).pipe(logLevel),
);

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );
