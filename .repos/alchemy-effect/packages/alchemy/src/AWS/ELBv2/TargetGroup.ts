import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type TargetGroupName = string;
export type TargetGroupArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:targetgroup/${string}`;

export interface TargetGroupProps {
  name?: string;
  vpcId: string;
  port: number;
  protocol?: "HTTP" | "HTTPS" | "TCP";
  targetType?: "ip" | "instance";
  healthCheckPath?: string;
  healthCheckPort?: string;
  healthCheckProtocol?: string;
  matcher?: { HttpCode?: string; GrpcCode?: string };
  attributes?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface TargetGroup extends Resource<
  "AWS.ELBv2.TargetGroup",
  TargetGroupProps,
  {
    targetGroupArn: TargetGroupArn;
    targetGroupName: TargetGroupName;
    port: number;
    protocol: string;
    targetType: string;
    vpcId: string;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

export const TargetGroup = Resource<TargetGroup>("AWS.ELBv2.TargetGroup");

export const TargetGroupProvider = () =>
  Provider.effect(
    TargetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 32, lowercase: true });

      return {
        stables: ["targetGroupArn", "targetGroupName", "vpcId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(
              {
                vpcId: olds.vpcId,
                protocol: olds.protocol ?? "HTTP",
                port: olds.port,
                targetType: olds.targetType ?? "ip",
              },
              {
                vpcId: news.vpcId,
                protocol: news.protocol ?? "HTTP",
                port: news.port,
                targetType: news.targetType ?? "ip",
              },
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) {
            return undefined;
          }
          const described = yield* elbv2
            .describeTargetGroups({
              TargetGroupArns: [output.targetGroupArn],
            })
            .pipe(
              Effect.catchTag("TargetGroupNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const targetGroup = described?.TargetGroups?.[0];
          if (!targetGroup?.TargetGroupArn) {
            return undefined;
          }
          return {
            ...output,
            port: targetGroup.Port!,
            protocol: targetGroup.Protocol!,
            targetType: targetGroup.TargetType!,
            vpcId: targetGroup.VpcId!,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — look up by deterministic name.
          let described = yield* elbv2
            .describeTargetGroups({
              Names: [name],
            })
            .pipe(
              Effect.catchTag("TargetGroupNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          let targetGroup = described?.TargetGroups?.[0];

          // Ensure — create if missing. Stable axes (vpcId, port, protocol,
          // targetType) are handled by diff so we don't deal with mismatch.
          if (!targetGroup?.TargetGroupArn) {
            const created = yield* elbv2.createTargetGroup({
              Name: name,
              Port: news.port,
              Protocol: news.protocol ?? "HTTP",
              VpcId: news.vpcId,
              TargetType: news.targetType ?? "ip",
              HealthCheckPath: news.healthCheckPath,
              HealthCheckPort: news.healthCheckPort,
              HealthCheckProtocol: news.healthCheckProtocol,
              Matcher: news.matcher,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            targetGroup = created.TargetGroups?.[0];
            if (!targetGroup?.TargetGroupArn) {
              return yield* Effect.die(
                new Error("createTargetGroup returned no target group"),
              );
            }
          }

          const targetGroupArn = targetGroup.TargetGroupArn as TargetGroupArn;

          // Sync health check — modifyTargetGroup fully replaces these
          // mutable fields.
          yield* elbv2.modifyTargetGroup({
            TargetGroupArn: targetGroupArn,
            HealthCheckPath: news.healthCheckPath,
            HealthCheckPort: news.healthCheckPort,
            HealthCheckProtocol: news.healthCheckProtocol,
            Matcher: news.matcher,
          });

          // Sync attributes — observed ↔ desired. Always apply when desired
          // attrs are non-empty.
          if (news.attributes && Object.keys(news.attributes).length > 0) {
            yield* elbv2.modifyTargetGroupAttributes({
              TargetGroupArn: targetGroupArn,
              Attributes: Object.entries(news.attributes).map(
                ([Key, Value]) => ({
                  Key,
                  Value,
                }),
              ),
            });
          }

          // Sync tags — diff observed cloud tags against desired.
          const tagDescriptions = yield* elbv2.describeTags({
            ResourceArns: [targetGroupArn],
          });
          const observedTags = Object.fromEntries(
            (tagDescriptions.TagDescriptions?.[0]?.Tags ?? [])
              .filter(
                (t): t is { Key: string; Value: string } =>
                  typeof t.Key === "string" && typeof t.Value === "string",
              )
              .map((t) => [t.Key, t.Value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* elbv2.addTags({
              ResourceArns: [targetGroupArn],
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* elbv2.removeTags({
              ResourceArns: [targetGroupArn],
              TagKeys: removed,
            });
          }

          yield* session.note(targetGroupArn);
          return {
            targetGroupArn,
            targetGroupName: targetGroup.TargetGroupName!,
            port: targetGroup.Port!,
            protocol: targetGroup.Protocol!,
            targetType: targetGroup.TargetType!,
            vpcId: targetGroup.VpcId!,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* elbv2
            .deleteTargetGroup({
              TargetGroupArn: output.targetGroupArn,
            })
            .pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );
