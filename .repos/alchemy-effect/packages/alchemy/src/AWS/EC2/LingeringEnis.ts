import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/**
 * Shared teardown accelerator for network interfaces that AWS releases
 * *asynchronously* after their owning resource is deleted.
 *
 * The canonical case is a VPC-attached Lambda Function: `DeleteFunction`
 * returns immediately, but the function's Hyperplane ENIs stay `in-use` in
 * their subnets/security groups for several minutes, and Lambda's own reaper
 * may not delete the detached ENI for up to ~20 minutes. Until the ENI is
 * gone, `DeleteSubnet`/`DeleteSecurityGroup` fail with `DependencyViolation`
 * — historically forcing users to run `destroy` twice, minutes apart.
 *
 * `retryWhileLingeringEnis` wraps a subnet/security-group delete call:
 * on every `DependencyViolation` it observes the ENIs still occupying the
 * resource, explicitly deletes any *detached* (status `available`) Lambda
 * ENI instead of waiting for Lambda's reaper, and — while the blockers are
 * exclusively Lambda ENIs that are provably on their way out — keeps waiting
 * on an extended budget that covers AWS's worst-case release window. Any
 * other lingering dependency keeps today's shorter budget.
 */

/**
 * ENIs that their owning service tears down asynchronously and that are safe
 * for us to delete once detached. Only Lambda Hyperplane ENIs qualify today:
 * every other managed type (NAT gateways, VPC endpoints, ELB, EFS mount
 * targets, ECS task ENIs) is deleted by the API call that deletes its owner
 * — and their owners are proper alchemy resources ordered ahead of the
 * subnet/SG by the deletion graph.
 *
 * Matching note (observed live): while attached, a Hyperplane ENI reports
 * `InterfaceType: "lambda"` — but the moment Lambda detaches it, the type
 * flips to plain `"interface"` and only the description (`AWS Lambda VPC
 * ENI-{functionName}`) still identifies it. Match both, like Terraform does.
 */
const isReapableEni = (eni: ec2.NetworkInterface): boolean =>
  eni.InterfaceType === "lambda" ||
  (eni.Description?.startsWith("AWS Lambda VPC ENI") ?? false);

export interface LingeringEniScope {
  /** ENI filter naming the resource being deleted. */
  readonly name: "subnet-id" | "group-id";
  readonly value: string;
}

/**
 * Observe ENIs still occupying the resource and delete any detached
 * reapable ones. Best-effort by design: the reaper only accelerates the
 * outer DependencyViolation retry, so an account that cannot describe or
 * delete ENIs degrades to plain waiting instead of failing the destroy.
 */
const reapLingeringEnis = Effect.fn(function* (
  scope: LingeringEniScope,
  session: { note: (note: string) => Effect.Effect<void> },
) {
  const described = yield* ec2
    .describeNetworkInterfaces({
      Filters: [{ Name: scope.name, Values: [scope.value] }],
    })
    .pipe(Effect.catch(() => Effect.succeed({ NetworkInterfaces: [] })));

  const lingering = (described.NetworkInterfaces ?? []).filter(isReapableEni);

  let reaped = 0;
  let pending = 0;
  for (const eni of lingering) {
    if (eni.Status !== "available" || eni.NetworkInterfaceId === undefined) {
      pending += 1;
      continue;
    }
    const outcome = yield* ec2
      .deleteNetworkInterface({
        NetworkInterfaceId: eni.NetworkInterfaceId,
      })
      .pipe(
        Effect.as("deleted" as const),
        // Already gone counts as progress; anything else (raced back to
        // in-use, throttle, missing IAM permission) must not fail the
        // destroy — reaping is purely an accelerator, so degrade to the
        // outer retry's plain waiting.
        Effect.catchTag("InvalidNetworkInterfaceID.NotFound", () =>
          Effect.succeed("deleted" as const),
        ),
        Effect.catch(() => Effect.succeed("pending" as const)),
      );
    if (outcome === "deleted") {
      yield* session.note(
        `Deleted detached Lambda ENI ${eni.NetworkInterfaceId}`,
      );
      reaped += 1;
    } else {
      pending += 1;
    }
  }

  return {
    /** Reapable ENIs still occupying the resource after this pass. */
    pendingReapable: pending,
    /** Detached reapable ENIs actually deleted this pass. */
    reaped,
  };
});

/**
 * Retry `deleteCall` while it fails with a dependency violation, reaping
 * lingering ENIs between attempts.
 *
 * - Base budget (~12 min) matches the historical subnet schedule: fast
 *   exponential start, capped at 30-second steps.
 * - While the observed blockers include reapable ENIs (attached or just
 *   reaped), the budget extends to ~25 min — Lambda's documented worst-case
 *   ENI release window — because those blockers are guaranteed to clear.
 */
export const retryWhileLingeringEnis = <A, E extends { _tag: string }, R>(
  deleteCall: Effect.Effect<A, E, R>,
  options: {
    scope: LingeringEniScope;
    isDependencyViolation: (error: E) => boolean;
    session: { note: (note: string) => Effect.Effect<void> };
  },
) =>
  Effect.gen(function* () {
    const BASE_BUDGET_MILLIS = 12 * 60 * 1000;
    const EXTENDED_BUDGET_MILLIS = 25 * 60 * 1000;

    let elapsedMillis = 0;
    let sawReapable = false;

    for (let attempt = 1; ; attempt++) {
      const result = yield* Effect.result(deleteCall);
      if (Result.isSuccess(result)) {
        return result.success;
      }
      const error = result.failure;
      if (!options.isDependencyViolation(error)) {
        return yield* Effect.fail(error);
      }

      const { pendingReapable, reaped } = yield* reapLingeringEnis(
        options.scope,
        options.session,
      );
      if (reaped > 0) {
        // An ENI just left — the next attempt has a real chance; skip the
        // backoff sleep and try immediately.
        continue;
      }
      sawReapable ||= pendingReapable > 0;

      const budget = sawReapable ? EXTENDED_BUDGET_MILLIS : BASE_BUDGET_MILLIS;
      if (elapsedMillis >= budget) {
        return yield* Effect.fail(error);
      }

      yield* options.session.note(
        pendingReapable > 0
          ? `Waiting for AWS to release ${pendingReapable} lingering ENI(s)... (attempt ${attempt})`
          : `Waiting for dependencies to clear... (attempt ${attempt})`,
      );

      // Fast exponential start capped at 30-second steps (the historical
      // subnet schedule).
      const delayMillis = Math.min(1000 * 1.5 ** (attempt - 1), 30_000);
      yield* Effect.sleep(delayMillis);
      elapsedMillis += delayMillis;
    }
  });
