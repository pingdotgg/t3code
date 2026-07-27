import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls. The backoff is CAPPED at 3s: an
// uncapped exponential balloons to 64s+ gaps within a handful of
// attempts, polling so sparsely that a settled token is detected tens
// of seconds late — under full-suite parallel load (when propagation
// windows stretch) that alone can blow the test timeout.
const propagationSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

const getToken = (accountId: string, id: string) =>
  aisearch.readToken({ accountId, id }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: propagationSchedule,
      times: 15,
    }),
  );

const expectGone = (accountId: string, id: string) =>
  getToken(accountId, id).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "TokenNotDeleted" } as const)),
    // A missing token surfaces as `TokenNotFound` (Cloudflare error code
    // 7075) — that's the success condition here.
    Effect.catchTag("TokenNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "TokenNotDeleted",
      schedule: propagationSchedule,
      times: 15,
    }),
  );

// AI Search validates the underlying credential on create/update — it
// must carry the "AI Search Index Engine" permission group, so the test
// mints a scoped account API token in the same stack and feeds its id +
// value into the service token.
const program = (
  accountId: string,
  props?: Partial<Cloudflare.AI.SearchTokenProps>,
) =>
  Effect.gen(function* () {
    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("TokenSource", {
      policies: [
        {
          effect: "allow",
          permissionGroups: ["AI Search Index Engine"],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });
    const token = yield* Cloudflare.AI.SearchToken("Token", {
      cfApiId: apiToken.tokenId,
      cfApiKey: apiToken.value,
      ...props,
    });
    return { apiToken, token };
  });

test.provider(
  "create, rename in place, and delete a service token",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const user = (process.env.USER ?? "test").toLowerCase();
      const renamed = `${user}-alchemy-aisearch-token-renamed`;

      yield* stack.destroy();

      // Create — engine-generated display name.
      const initial = yield* stack.deploy(program(accountId));

      expect(initial.token.id).toBeTruthy();
      expect(initial.token.accountId).toEqual(accountId);
      expect(initial.token.cfApiId).toEqual(initial.apiToken.tokenId);
      expect(initial.token.name).toBeTruthy();

      const live = yield* getToken(accountId, initial.token.id);
      expect(live.id).toEqual(initial.token.id);
      expect(live.cfApiId).toEqual(initial.apiToken.tokenId);
      expect(live.name).toEqual(initial.token.name);

      // Rename in place — the service token id is stable.
      const updated = yield* stack.deploy(
        program(accountId, { name: renamed }),
      );

      expect(updated.token.id).toEqual(initial.token.id);
      expect(updated.token.name).toEqual(renamed);

      const liveUpdated = yield* getToken(accountId, updated.token.id);
      expect(liveUpdated.name).toEqual(renamed);

      // Redeploying identical props is a no-op (still the same token).
      const noop = yield* stack.deploy(program(accountId, { name: renamed }));
      expect(noop.token.id).toEqual(initial.token.id);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.token.id);

      // Destroy again — delete must be idempotent (already gone).
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "recreates after out-of-band delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const user = (process.env.USER ?? "test").toLowerCase();

      yield* stack.destroy();

      const initial = yield* stack.deploy(program(accountId));

      // Delete the service token out-of-band. A redeploy with identical
      // props is a planner no-op, so change a mutable prop to force
      // reconcile — it must observe the token as missing and recreate it
      // instead of failing on a 404.
      yield* aisearch.deleteToken({ accountId, id: initial.token.id }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: propagationSchedule,
          times: 15,
        }),
      );
      yield* expectGone(accountId, initial.token.id);

      const healed = yield* stack.deploy(
        program(accountId, { name: `${user}-alchemy-aisearch-token-healed` }),
      );

      // A new physical token exists (the id is assigned by Cloudflare).
      expect(healed.token.id).not.toEqual(initial.token.id);
      const live = yield* getToken(accountId, healed.token.id);
      expect(live.id).toEqual(healed.token.id);

      yield* stack.destroy();

      yield* expectGone(accountId, healed.token.id);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed service token",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(program(accountId));

      const provider = yield* Provider.findProvider(Cloudflare.AI.SearchToken);
      const all = yield* provider.list();

      const found = all.find((t) => t.id === deployed.token.id);
      expect(found).toBeDefined();
      // list() emits the exact `read` Attributes shape.
      expect(found?.accountId).toEqual(accountId);
      expect(found?.cfApiId).toEqual(deployed.apiToken.tokenId);
      expect(found?.name).toEqual(deployed.token.name);

      yield* stack.destroy();

      yield* expectGone(accountId, deployed.token.id);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "an AI Search instance syncs with a stack-minted service token",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Full composition: AccountApiToken → AiSearchToken → Bucket →
      // AiSearchInstance wired to the service token via `tokenId`.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { apiToken, token } = yield* program(accountId);
          const bucket = yield* Cloudflare.R2.Bucket("AiSearchTokenSource", {});
          const instance = yield* Cloudflare.AI.Search("Search", {
            // Pass the Bucket resource (not `bucket.bucketName`) so the
            // construct selects the R2 source path; a bare string is treated
            // as a web-crawler seed URL.
            source: bucket,
            tokenId: token.id,
          });
          return { apiToken, token, bucket, instance };
        }),
      );

      expect(deployed.instance.tokenId).toEqual(deployed.token.id);

      const live = yield* aisearch
        .readInstance({ accountId, id: deployed.instance.instanceId })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: propagationSchedule,
            times: 15,
          }),
        );
      expect(live.tokenId).toEqual(deployed.token.id);

      yield* stack.destroy();

      // The instance deletes before the token it references.
      yield* expectGone(accountId, deployed.token.id);
    }).pipe(logLevel),
  // The instance create validates the freshly-minted service token and can
  // legitimately ride the provider's `InvalidTokenCredentials` propagation
  // window (~2 min under full-suite parallel load) before the deploy even
  // returns — 240s leaves no room for the destroy + gone-poll that follow.
  { timeout: 360_000 },
);
