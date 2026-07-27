import * as Lambda from "@/AWS/Lambda";
import * as Shield from "@/AWS/Shield";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ShieldTestFunction extends Lambda.Function<Lambda.Function>()(
  "ShieldTestFunction",
) {}

/**
 * Routes answer `{ …fields }` on success or `{ errorTag }` when the operation
 * fails with a TYPED error — the test asserts the tag is in a route-specific
 * allowlist, which proves both the binding wiring and the IAM grant. An
 * untyped error crashes into a 500 instead.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string; errorMessage?: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string; errorMessage?: string } => a),
    Effect.catch((e) =>
      Effect.succeed({
        errorTag: e._tag,
        errorMessage:
          (e as { Message?: string }).Message ??
          (e as { message?: string }).message,
      }),
    ),
  );

// The testing account is NOT (and must never be) subscribed to Shield
// Advanced ($3,000/month, 1-year commitment). GetSubscriptionState and
// DescribeAttackStatistics succeed on any account; the subscription-gated
// operations answer with their typed entitlement/not-found tags, which the
// test asserts — proving the binding + IAM wiring end-to-end either way.
export default ShieldTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to Shield Advanced attack events
    // (AWS Health, source `aws.health`, service SHIELD). The deploy proves
    // the EventBridge rule + invoke permission wiring; events only fire on
    // subscribed accounts under active attack.
    yield* Shield.consumeAttackEvents({}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(`shield attack event: ${event.detail.eventTypeCode}`),
      ),
    );

    const getSubscriptionState = yield* Shield.GetSubscriptionState();
    const describeAttackStatistics = yield* Shield.DescribeAttackStatistics();
    const listAttacks = yield* Shield.ListAttacks();
    const describeAttack = yield* Shield.DescribeAttack();
    const describeDRTAccess = yield* Shield.DescribeDRTAccess();
    const listResourcesInProtectionGroup =
      yield* Shield.ListResourcesInProtectionGroup();

    const bound = {
      getSubscriptionState,
      describeAttackStatistics,
      listAttacks,
      describeAttack,
      describeDRTAccess,
      listResourcesInProtectionGroup,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // Available to every account, subscribed or not.
        if (request.method === "GET" && pathname === "/subscription-state") {
          const { SubscriptionState } = yield* getSubscriptionState();
          return yield* HttpServerResponse.json({ state: SubscriptionState });
        }

        // Available to Standard and Advanced customers alike.
        if (request.method === "GET" && pathname === "/attack-stats") {
          const result = yield* errorTagged(
            describeAttackStatistics().pipe(
              Effect.map((r) => ({ dataItems: r.DataItems.length })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Subscription-gated — a non-subscribed account answers with a typed
        // error tag.
        if (request.method === "GET" && pathname === "/attacks") {
          const result = yield* errorTagged(
            listAttacks().pipe(
              Effect.map((r) => ({
                count: (r.AttackSummaries ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // A nonexistent attack id answers with an empty document (observed
        // live) or the documented typed AccessDeniedException.
        if (request.method === "GET" && pathname === "/attack-detail") {
          const result = yield* errorTagged(
            describeAttack({
              AttackId: "00000000-0000-0000-0000-000000000000",
            }).pipe(Effect.map((r) => ({ attackId: r.Attack?.AttackId }))),
          );
          return yield* HttpServerResponse.json(result);
        }

        // Subscription-gated — a non-subscribed account answers with the
        // typed ResourceNotFoundException.
        if (request.method === "GET" && pathname === "/drt-access") {
          const result = yield* errorTagged(
            describeDRTAccess().pipe(
              Effect.map((r) => ({
                roleArn: r.RoleArn ?? null,
                logBuckets: (r.LogBucketList ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // A nonexistent group answers with the typed
        // ResourceNotFoundException (even without a subscription).
        if (request.method === "GET" && pathname === "/group-members") {
          const result = yield* errorTagged(
            listResourcesInProtectionGroup({
              ProtectionGroupId: "alchemy-shield-bindings-nonexistent",
            }).pipe(
              Effect.map((r) => ({
                count: (r.ResourceArns ?? []).length,
              })),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface typed operation errors as JSON so live-test failures carry
        // the tag + message instead of an opaque 500 (routes that expect a
        // typed error use `errorTagged` above and never reach this).
        Effect.catch((e) =>
          HttpServerResponse.json(
            {
              errorTag: (e as { _tag?: string })._tag ?? "UnknownError",
              errorMessage:
                (e as { message?: string }).message ??
                (e as { Message?: string }).Message,
            },
            { status: 500 },
          ),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Shield.GetSubscriptionStateHttp,
        Shield.DescribeAttackStatisticsHttp,
        Shield.ListAttacksHttp,
        Shield.DescribeAttackHttp,
        Shield.DescribeDRTAccessHttp,
        Shield.ListResourcesInProtectionGroupHttp,
      ),
    ),
  ),
);
