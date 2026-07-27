/**
 * Shared scaffolding for the Amazon S3 Control HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeS3Control…HttpBinding({ … }))` over one of the
 * builders below. Every S3 Control request carries the owning `AccountId`
 * (an endpoint host label), so each builder's only real job is deciding
 * where that account id comes from:
 *
 * - Access-point-scoped operations inject `AccountId` + `Name` from the
 *   bound {@link AccessPoint} and are granted on the access point ARN.
 * - Multi-Region Access Point operations inject `AccountId` + `Mrap` from
 *   the bound {@link MultiRegionAccessPoint}, are granted on the MRAP ARN,
 *   and are pinned to `us-west-2` (the region the MRAP control plane and
 *   route APIs are served from).
 * - Account-level operations (access point listing, S3 Batch Operations
 *   jobs) resolve the caller's account once via `sts:GetCallerIdentity`
 *   (cached per binding) and are granted on `*` — job ARNs are
 *   server-assigned at runtime and unknowable at deploy time.
 */
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { AccessPoint } from "./AccessPoint.ts";
import type { MultiRegionAccessPoint } from "./MultiRegionAccessPoint.ts";

/**
 * All Multi-Region Access Point control-plane requests are routed to the
 * US West (Oregon) region regardless of the ambient region — mirrors the
 * {@link MultiRegionAccessPoint} resource provider.
 */
const inMrapRegion = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Region>> =>
  self.pipe(Effect.provideService(Region, Effect.succeed("us-west-2")));

/**
 * Build the impl Effect for an S3 Control operation scoped to an
 * {@link AccessPoint}: the deploy-time half grants `actions` on the bound
 * access point's ARN, and the runtime half injects the access point's
 * `AccountId` and `Name` into every request.
 */
export const makeS3ControlAccessPointHttpBinding = <
  I extends { AccountId: string; Name: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.S3Control.GetAccessPoint`. */
  tag: string;
  /** The distilled operation; `AccountId`/`Name` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the access point ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (accessPoint: AccessPoint) {
      const AccountId = yield* accessPoint.accountId;
      const Name = yield* accessPoint.accessPointName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${accessPoint}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [accessPoint.accessPointArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${accessPoint.LogicalId})`)(function* (
        request?: Omit<I, "AccountId" | "Name">,
      ) {
        return yield* op({
          ...request,
          AccountId: yield* AccountId,
          Name: yield* Name,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an S3 Control operation scoped to a
 * {@link MultiRegionAccessPoint}: the deploy-time half grants `actions` on
 * the bound MRAP's ARN, and the runtime half injects the MRAP's `AccountId`
 * and alias-addressed ARN (`Mrap`) into every request, pinned to the
 * `us-west-2` MRAP control-plane region.
 */
export const makeS3ControlMrapHttpBinding = <
  I extends { AccountId: string; Mrap: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.S3Control.GetMultiRegionAccessPointRoutes`. */
  tag: string;
  /** The distilled operation; `AccountId`/`Mrap` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the Multi-Region Access Point ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* inMrapRegion(options.operation);

    return Effect.fn(function* (mrap: MultiRegionAccessPoint) {
      const AccountId = yield* mrap.accountId;
      const Mrap = yield* mrap.multiRegionAccessPointArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${mrap}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [mrap.multiRegionAccessPointArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${mrap.LogicalId})`)(function* (
        request?: Omit<I, "AccountId" | "Mrap">,
      ) {
        return yield* op({
          ...request,
          AccountId: yield* AccountId,
          Mrap: yield* Mrap,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level S3 Control operation (access
 * point listing, S3 Batch Operations jobs). The deploy-time half grants
 * `actions` on `*` — job ARNs are server-assigned at runtime and unknowable
 * at deploy time. The runtime half resolves the caller's account id once via
 * `sts:GetCallerIdentity` (needs no extra IAM permission) and injects it as
 * `AccountId`.
 */
export const makeS3ControlAccountHttpBinding = <
  I extends { AccountId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.S3Control.ListJobs`. */
  tag: string;
  /** The distilled operation; `AccountId` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
  /**
   * Grant `iam:PassRole` so the function can hand S3 Batch Operations the
   * execution role named in the job. Set on `CreateJob`. Matches the AWS
   * Batch Operations permission model (an `iam:PassedToService` condition is
   * NOT populated for `s3:CreateJob` — IAM denies a conditioned grant).
   */
  passRole?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;
    const getCallerIdentity = yield* sts.getCallerIdentity;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const policyStatements: PolicyStatement[] = [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: ["*"],
            },
          ];
          if (options.passRole) {
            // No `iam:PassedToService` condition — IAM does not populate the
            // key for `s3:CreateJob`, so a conditioned grant is always
            // denied. This matches the policy AWS documents for Batch
            // Operations job creators.
            policyStatements.push({
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: ["*"],
            });
          }
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements,
          });
        }
      }
      // Resolve the caller's account id lazily (first call inside the
      // Lambda) and cache it for the life of the binding.
      const accountId = yield* Effect.cached(
        getCallerIdentity({}).pipe(Effect.map((r) => r.Account!)),
      );
      return Effect.fn(options.tag)(function* (request?: Omit<I, "AccountId">) {
        return yield* op({
          ...request,
          AccountId: yield* accountId,
        } as I);
      });
    });
  });
