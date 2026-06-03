import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type EgressOnlyInternetGatewayId<ID extends string = string> =
  `eigw-${ID}`;
export const EgressOnlyInternetGatewayId = <ID extends string>(
  id: ID,
): ID & EgressOnlyInternetGatewayId<ID> =>
  `eigw-${id}` as ID & EgressOnlyInternetGatewayId<ID>;

export type EgressOnlyInternetGatewayArn<
  ID extends EgressOnlyInternetGatewayId = EgressOnlyInternetGatewayId,
> = `arn:aws:ec2:${RegionID}:${AccountID}:egress-only-internet-gateway/${ID}`;

export interface EgressOnlyInternetGatewayProps {
  /**
   * The VPC for which to create the egress-only internet gateway.
   */
  vpcId: VpcId;

  /**
   * Tags to assign to the egress-only internet gateway.
   */
  tags?: Record<string, string>;
}

export interface EgressOnlyInternetGateway extends Resource<
  "AWS.EC2.EgressOnlyInternetGateway",
  EgressOnlyInternetGatewayProps,
  {
    /**
     * The ID of the egress-only internet gateway.
     */
    egressOnlyInternetGatewayId: EgressOnlyInternetGatewayId;

    /**
     * The Amazon Resource Name (ARN) of the egress-only internet gateway.
     */
    egressOnlyInternetGatewayArn: EgressOnlyInternetGatewayArn;

    /**
     * Information about the attachment of the egress-only internet gateway.
     */
    attachments?: Array<{
      /**
       * The current state of the attachment.
       */
      state: "attaching" | "attached" | "detaching" | "detached";
      /**
       * The ID of the VPC.
       */
      vpcId: VpcId;
    }>;
  },
  never,
  Providers
> {}
export const EgressOnlyInternetGateway = Resource<EgressOnlyInternetGateway>(
  "AWS.EC2.EgressOnlyInternetGateway",
);

export const EgressOnlyInternetGatewayProvider = () =>
  Provider.effect(
    EgressOnlyInternetGateway,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const describeEgressOnlyInternetGateway = (eigwId: string) =>
        ec2
          .describeEgressOnlyInternetGateways({
            EgressOnlyInternetGatewayIds: [eigwId],
          })
          .pipe(
            Effect.map((r) => r.EgressOnlyInternetGateways?.[0]),
            Effect.flatMap((gw) =>
              gw
                ? Effect.succeed(gw)
                : Effect.fail(
                    new Error(
                      `Egress-Only Internet Gateway ${eigwId} not found`,
                    ),
                  ),
            ),
          );

      const toAttrs = (gw: ec2.EgressOnlyInternetGateway) => ({
        egressOnlyInternetGatewayId:
          gw.EgressOnlyInternetGatewayId as EgressOnlyInternetGatewayId,
        egressOnlyInternetGatewayArn:
          `arn:aws:ec2:${region}:${accountId}:egress-only-internet-gateway/${gw.EgressOnlyInternetGatewayId}` as EgressOnlyInternetGatewayArn,
        attachments: gw.Attachments?.map((a) => ({
          state: a.State as "attaching" | "attached" | "detaching" | "detached",
          vpcId: a.VpcId as VpcId,
        })),
      });

      return {
        stables: [
          "egressOnlyInternetGatewayId",
          "egressOnlyInternetGatewayArn",
        ],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const gw = yield* describeEgressOnlyInternetGateway(
            output.egressOnlyInternetGatewayId,
          );
          return toAttrs(gw);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // VPC change requires replacement
          if (news.vpcId !== olds.vpcId) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the EIGW via cached id, else fall through to create.
          let gw: ec2.EgressOnlyInternetGateway | undefined;
          if (output?.egressOnlyInternetGatewayId) {
            const lookup = yield* ec2
              .describeEgressOnlyInternetGateways({
                EgressOnlyInternetGatewayIds: [
                  output.egressOnlyInternetGatewayId,
                ],
              })
              .pipe(
                Effect.catchTag(
                  "InvalidEgressOnlyInternetGatewayId.NotFound",
                  () => Effect.succeed({ EgressOnlyInternetGateways: [] }),
                ),
              );
            gw = lookup.EgressOnlyInternetGateways?.[0];
          }

          // Ensure — create the EIGW if it isn't there yet.
          if (gw === undefined) {
            yield* session.note("Creating Egress-Only Internet Gateway...");
            const result = yield* ec2.createEgressOnlyInternetGateway({
              VpcId: news.vpcId as string,
              TagSpecifications: [
                {
                  ResourceType: "egress-only-internet-gateway",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const newGwId =
              result.EgressOnlyInternetGateway!.EgressOnlyInternetGatewayId!;
            yield* session.note(
              `Egress-Only Internet Gateway created: ${newGwId}`,
            );
            gw = yield* describeEgressOnlyInternetGateway(newGwId);
          }

          const eigwId = gw.EgressOnlyInternetGatewayId!;

          // Sync tags — observed cloud tags vs desired.
          const currentTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [eigwId] },
                  {
                    Name: "resource-type",
                    Values: ["egress-only-internet-gateway"],
                  },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
                ),
              )) ?? {};
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [eigwId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [eigwId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // Re-read to reflect current cloud state in the returned attributes.
          const final = yield* describeEgressOnlyInternetGateway(eigwId);
          return toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const eigwId = output.egressOnlyInternetGatewayId;

          yield* session.note(
            `Deleting Egress-Only Internet Gateway: ${eigwId}`,
          );

          yield* ec2
            .deleteEgressOnlyInternetGateway({
              EgressOnlyInternetGatewayId: eigwId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag("InvalidGatewayID.NotFound", () => Effect.void),
              Effect.catchTag(
                "InvalidEgressOnlyInternetGatewayId.NotFound",
                () => Effect.void,
              ),
              // Retry on dependency violations (e.g., routes still using the EIGW)
              Effect.retry({
                while: (e: { _tag: string }) =>
                  e._tag === "DependencyViolation",
                schedule: Schedule.fixed(5000).pipe(
                  Schedule.both(Schedule.recurs(30)), // Up to ~2.5 minutes
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Egress-Only Internet Gateway ${eigwId} deleted`);
        }),
      };
    }),
  );
