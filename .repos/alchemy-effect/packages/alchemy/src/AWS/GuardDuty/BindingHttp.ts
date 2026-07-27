import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Detector } from "./Detector.ts";

/**
 * Shared scaffolding for Amazon GuardDuty HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a GuardDuty operation scoped to a
 * {@link Detector}: the deploy-time half grants `actions` (on the bound
 * detector's ARN where the action supports resource-level permissions,
 * otherwise on `*`), and the runtime half injects the detector's
 * `DetectorId` into every request.
 */
export const makeGuardDutyDetectorHttpBinding = <
  I extends { DetectorId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.GuardDuty.ListFindings`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted. */
  actions: readonly string[];
  /**
   * Whether the IAM action supports resource-level permissions on the
   * detector ARN. Most GuardDuty detector-scoped actions do NOT — IAM only
   * evaluates them against `Resource: "*"` (verified empirically: an
   * ARN-scoped Allow is an implicit deny for e.g. `ListFindings`,
   * `ListMembers`, `CreateSampleFindings`). Only the coverage actions
   * (`ListCoverage`, `GetCoverageStatistics`) opt in.
   * @default false
   */
  resourceLevel?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (detector: Detector) {
      const DetectorId = yield* detector.detectorId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${detector}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.resourceLevel
                  ? [detector.detectorArn]
                  : ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${detector.LogicalId})`)(function* (
        request?: Omit<I, "DetectorId">,
      ) {
        const detectorId = yield* DetectorId;
        return yield* op({ ...request, DetectorId: detectorId } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level GuardDuty operation — the
 * member-account invitation flow (`ListInvitations`, `DeclineInvitations`,
 * `DeleteInvitations`, `GetInvitationsCount`), the organization-admin
 * actions, and the on-demand malware scan operations. The deploy-time half
 * grants `actions` on `*`: these operations either take no resource at all
 * or target resources (EC2 instances, S3 objects, foreign detectors) whose
 * ARNs are only known at runtime.
 */
export const makeGuardDutyAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.GuardDuty.ListInvitations`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
