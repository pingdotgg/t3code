import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { type TargetGroup, type TargetGroupArn } from "./TargetGroup.ts";

export interface TargetGroupAttachmentProps {
  /** The target group to register the target with. Changing it replaces the attachment. */
  targetGroupArn: Input<TargetGroupArn> | TargetGroup;
  /**
   * The target ID: an instance ID (`instance` target type), an IP address
   * (`ip`), a Lambda function ARN (`lambda`), or an ALB ARN (`alb`). Changing
   * it replaces the attachment.
   */
  targetId: string;
  /**
   * The port on which the target receives traffic. Defaults to the target
   * group port. Not applicable to `lambda` targets. Changing it replaces the
   * attachment.
   */
  port?: number;
  /**
   * The Availability Zone of the target. Set to `all` to register an IP
   * target outside the target group's VPC (e.g. an on-prem address). Changing
   * it replaces the attachment.
   */
  availabilityZone?: string;
}

export interface TargetGroupAttachment extends Resource<
  "AWS.ELBv2.TargetGroupAttachment",
  TargetGroupAttachmentProps,
  {
    /** The ARN of the target group the target is registered with. */
    targetGroupArn: TargetGroupArn;
    /** The registered target: an instance ID, IP address, or Lambda/ALB ARN. */
    targetId: string;
    /** The port the target receives traffic on, if applicable. */
    port: number | undefined;
    /** The Availability Zone the target was registered in, if specified. */
    availabilityZone: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Registers a single target (instance, IP address, Lambda function, or ALB)
 * with an ELBv2 target group. ECS services register their own tasks, so this
 * resource matters for Lambda-behind-ALB, EC2 instances, and static IPs.
 *
 * For `lambda` targets, the Lambda function's resource policy must allow
 * `elasticloadbalancing.amazonaws.com` to invoke it, scoped to the target
 * group ARN — create a {@link Permission} first. The provider retries the
 * registration briefly while that permission propagates.
 * @resource
 * @section Registering Targets
 * @example Lambda function target
 * ```typescript
 * const tg = yield* TargetGroup("fn", { targetType: "lambda" });
 * yield* Lambda.Permission("AlbInvoke", {
 *   action: "lambda:InvokeFunction",
 *   functionName: fn.functionArn.as<string>(),
 *   principal: "elasticloadbalancing.amazonaws.com",
 *   sourceArn: tg.targetGroupArn.as<string>(),
 * });
 * yield* TargetGroupAttachment("fn-target", {
 *   targetGroupArn: tg.targetGroupArn,
 *   targetId: fn.functionArn.as<string>(),
 * });
 * ```
 *
 * @example IP address target
 * ```typescript
 * yield* TargetGroupAttachment("ip-target", {
 *   targetGroupArn: tg.targetGroupArn,
 *   targetId: "10.0.1.15",
 *   port: 8080,
 * });
 * ```
 *
 * @example EC2 instance target
 * ```typescript
 * yield* TargetGroupAttachment("instance-target", {
 *   targetGroupArn: tg.targetGroupArn,
 *   targetId: instance.instanceId,
 *   port: 80,
 * });
 * ```
 */
export const TargetGroupAttachment = Resource<TargetGroupAttachment>(
  "AWS.ELBv2.TargetGroupAttachment",
);

// Registering a Lambda target validates that the function's resource policy
// grants elasticloadbalancing.amazonaws.com invoke permission. The Permission
// resource is often created in the same deploy with no data dependency on the
// attachment, so registerTargets can run before the policy lands. ELB surfaces
// the missing-permission case as either `InvalidTargetException` or an
// empty-message `AccessDeniedException` (both members of the registerTargets
// error union — AccessDeniedException via CommonErrors), so retry both briefly
// while IAM propagates. Explicitly typed so `Retry.Return`'s conditional type
// never leaks into declaration emit.
const retryThroughPermissionPropagation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidTargetException" || e._tag === "AccessDeniedException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(15)]),
  });

const wireTarget = (props: {
  targetId: string;
  port?: number;
  availabilityZone?: string;
}): elbv2.TargetDescription => ({
  Id: props.targetId,
  Port: props.port,
  AvailabilityZone: props.availabilityZone,
});

export const TargetGroupAttachmentProvider = () =>
  Provider.succeed(TargetGroupAttachment, {
    stables: ["targetGroupArn", "targetId", "port", "availabilityZone"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      // Registration has no mutable aspect — every change is a replacement.
      if (
        olds.targetGroupArn !== news.targetGroupArn ||
        olds.targetId !== news.targetId ||
        olds.port !== news.port ||
        olds.availabilityZone !== news.availabilityZone
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      // describeTargetHealth without an explicit Targets filter lists only
      // registered targets, so presence in the response means registered.
      const health = yield* elbv2
        .describeTargetHealth({ TargetGroupArn: output.targetGroupArn })
        .pipe(
          Effect.catchTag(["TargetGroupNotFoundException"], () =>
            Effect.succeed(undefined),
          ),
        );
      const registered = health?.TargetHealthDescriptions?.some(
        (d) =>
          d.Target?.Id === output.targetId &&
          (output.port === undefined || d.Target?.Port === output.port),
      );
      return registered ? output : undefined;
    }),
    // Attachments belong to a target group. Enumerate every target group,
    // then every registered target.
    list: Effect.fn(function* () {
      const targetGroupArns = yield* elbv2.describeTargetGroups.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.TargetGroups ?? []).flatMap((tg) =>
              tg.TargetGroupArn ? [tg.TargetGroupArn as TargetGroupArn] : [],
            ),
          ),
        ),
      );
      const rows = yield* Effect.forEach(
        targetGroupArns,
        (targetGroupArn) =>
          elbv2.describeTargetHealth({ TargetGroupArn: targetGroupArn }).pipe(
            Effect.map((health) =>
              (health.TargetHealthDescriptions ?? []).flatMap((d) =>
                d.Target?.Id
                  ? [
                      {
                        targetGroupArn,
                        targetId: d.Target.Id,
                        port: d.Target.Port,
                        availabilityZone: d.Target.AvailabilityZone,
                      },
                    ]
                  : [],
              ),
            ),
            // The group may vanish between enumeration and health lookup.
            Effect.catchTag(["TargetGroupNotFoundException"], () =>
              Effect.succeed([]),
            ),
          ),
        { concurrency: 10 },
      );
      const result: TargetGroupAttachment["Attributes"][] = rows.flat();
      return result;
    }),
    reconcile: Effect.fn(function* ({ news, session }) {
      const targetGroupArn = news.targetGroupArn as TargetGroupArn;
      const target = wireTarget(news);

      // Observe — is the target already registered?
      const health = yield* elbv2
        .describeTargetHealth({ TargetGroupArn: targetGroupArn })
        .pipe(
          Effect.catchTag(["InvalidTargetException"], () =>
            Effect.succeed(undefined),
          ),
        );
      const registered = health?.TargetHealthDescriptions?.some(
        (d) =>
          d.Target?.Id === news.targetId &&
          (news.port === undefined || d.Target?.Port === news.port),
      );

      // Ensure — registerTargets is an idempotent put, but skip the call
      // (and its permission-propagation retry) when already registered.
      if (!registered) {
        yield* retryThroughPermissionPropagation(
          elbv2.registerTargets({
            TargetGroupArn: targetGroupArn,
            Targets: [target],
          }),
        );
      }

      yield* session.note(`${news.targetId} -> ${targetGroupArn}`);
      return {
        targetGroupArn,
        targetId: news.targetId,
        port: news.port,
        availabilityZone: news.availabilityZone,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* elbv2
        .deregisterTargets({
          TargetGroupArn: output.targetGroupArn,
          Targets: [
            wireTarget({
              targetId: output.targetId,
              port: output.port,
              availabilityZone: output.availabilityZone,
            }),
          ],
        })
        .pipe(
          // Already deregistered / group already deleted.
          Effect.catchTag(
            ["InvalidTargetException", "TargetGroupNotFoundException"],
            () => Effect.void,
          ),
        );
    }),
  });
