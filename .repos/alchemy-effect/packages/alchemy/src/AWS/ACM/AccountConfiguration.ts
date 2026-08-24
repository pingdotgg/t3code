import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

export interface AccountConfigurationProps {
  /**
   * How long before certificate expiration ACM starts emitting daily
   * `ACM Certificate Approaching Expiration` EventBridge events for each
   * certificate in the account.
   *
   * The wire unit is whole days and AWS accepts between 1 and 45 days.
   * Accepts any `Duration.Input` (e.g. `"30 days"`); the provider converts to
   * whole days.
   *
   * @default "45 days" (the AWS account default)
   */
  daysBeforeExpiry?: Duration.Input;
}

export interface AccountConfiguration extends Resource<
  "AWS.ACM.AccountConfiguration",
  AccountConfigurationProps,
  {
    /**
     * Days before certificate expiration when ACM starts emitting expiry
     * events, as currently configured on the account.
     */
    daysBeforeExpiry: number;
  },
  never,
  Providers
> {}

/**
 * Account-level ACM configuration (`AWS::CertificateManager::Account`).
 *
 * ACM emits one `ACM Certificate Approaching Expiration` EventBridge event
 * per day per certificate starting `daysBeforeExpiry` days before each
 * certificate expires. This account-global singleton manages that threshold
 * via `acm:PutAccountConfiguration`. Deleting the resource resets the
 * threshold to the AWS default of 45 days.
 *
 * Like the {@link Certificate} resource, the provider pins its API calls to
 * `us-east-1`.
 *
 * @resource
 * @section Configuring Expiry Events
 * @example Start Expiry Events 30 Days Before Expiration
 * ```typescript
 * const config = yield* AccountConfiguration("AcmAccount", {
 *   daysBeforeExpiry: "30 days",
 * });
 * ```
 *
 * @example Consume the Expiry Events
 * ```typescript
 * // The events arrive on the default EventBridge bus with source "aws.acm".
 * yield* AWS.ACM.consumeExpiryEvents({}, (events) =>
 *   Stream.runForEach(events, (event) =>
 *     Effect.log(
 *       `${event.detail.CommonName} expires in ${event.detail.DaysToExpiry} days`,
 *     ),
 *   ),
 * );
 * ```
 */
export const AccountConfiguration = Resource<AccountConfiguration>(
  "AWS.ACM.AccountConfiguration",
);

/** The AWS account default for `DaysBeforeExpiry`. */
const DEFAULT_DAYS_BEFORE_EXPIRY = 45;

const ACM_REGION = "us-east-1" as const;

const withAcmRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // `AwsRegion`'s service value is an `Effect<RegionName>`, so it must be
  // provided as an effect, not a bare string.
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed(ACM_REGION)));

/**
 * ACM treats a repeated `IdempotencyToken` within one hour as the SAME
 * request: replaying a token with different parameters is a typed
 * `ConflictException`, and replaying it with the same parameters returns the
 * cached original result WITHOUT re-applying it. So the token must vary with
 * the desired value AND the attempt — the seed is truncated first so the
 * discriminating suffix always survives.
 */
const idempotencyToken = (seed: string, desiredDays: number, attempt: number) =>
  `${seed.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 20)}d${desiredDays}a${attempt}`;

export const AccountConfigurationProvider = () =>
  Provider.effect(
    AccountConfiguration,
    Effect.gen(function* () {
      const observe = withAcmRegion(
        acm.getAccountConfiguration({}).pipe(
          Effect.map((response) => ({
            daysBeforeExpiry:
              response.ExpiryEvents?.DaysBeforeExpiry ??
              DEFAULT_DAYS_BEFORE_EXPIRY,
          })),
        ),
      );

      // Converge the account threshold onto `desiredDays`, verifying the
      // observed value after each put. The verify loop covers the exotic
      // idempotency-cache case where ACM accepts a replayed token but does
      // not re-apply it (see `idempotencyToken`): the next attempt salts a
      // fresh token. Throttling is retried bounded.
      const put = Effect.fn(function* (desiredDays: number, tokenSeed: string) {
        for (let attempt = 0; attempt < 3; attempt++) {
          yield* withAcmRegion(
            acm
              .putAccountConfiguration({
                ExpiryEvents: { DaysBeforeExpiry: desiredDays },
                IdempotencyToken: idempotencyToken(
                  tokenSeed,
                  desiredDays,
                  attempt,
                ),
              })
              .pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "ThrottlingException",
                  schedule: Schedule.max([
                    Schedule.exponential("1 second"),
                    Schedule.recurs(5),
                  ]),
                }),
              ),
          );
          const observed = yield* observe;
          if (observed.daysBeforeExpiry === desiredDays) {
            return observed;
          }
        }
        return yield* Effect.fail(
          new Error(
            `ACM account configuration did not converge to ${desiredDays} days before expiry`,
          ),
        );
      });

      return {
        // Account-global singleton setting: nuke must not reset it.
        nuke: { singleton: true },
        stables: [],
        read: Effect.fn(function* () {
          return yield* observe;
        }),
        reconcile: Effect.fn(function* ({ instanceId, news, session }) {
          const desiredDays =
            toWireDays(news.daysBeforeExpiry) ?? DEFAULT_DAYS_BEFORE_EXPIRY;

          // Observe the live threshold; only call the API on a real delta.
          const observed = yield* observe;
          if (observed.daysBeforeExpiry !== desiredDays) {
            yield* put(desiredDays, instanceId);
          }

          yield* session.note(`${desiredDays} days before expiry`);
          return { daysBeforeExpiry: desiredDays };
        }),
        // Account-global singleton: the configuration always exists.
        list: () => observe.pipe(Effect.map((observed) => [observed])),
        // Deleting stops managing the threshold and restores the AWS
        // account default (45 days). Idempotent: a no-op when the account
        // is already at the default.
        delete: Effect.fn(function* ({ instanceId }) {
          const observed = yield* observe;
          if (observed.daysBeforeExpiry !== DEFAULT_DAYS_BEFORE_EXPIRY) {
            yield* put(DEFAULT_DAYS_BEFORE_EXPIRY, `${instanceId}reset`);
          }
        }),
      };
    }),
  );
