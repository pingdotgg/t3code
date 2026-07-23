import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { VpcId } from "./Vpc.ts";

export type InternetGatewayId<ID extends string = string> = `igw-${ID}`;
export const InternetGatewayId = <ID extends string>(
  id: ID,
): ID & InternetGatewayId<ID> => `igw-${id}` as ID & InternetGatewayId<ID>;

export interface InternetGatewayProps {
  /**
   * The VPC to attach the internet gateway to.
   * If provided, the internet gateway will be automatically attached to the VPC.
   * Optional - you can create an unattached internet gateway and attach it later.
   */
  vpcId?: VpcId;

  /**
   * Tags to assign to the internet gateway.
   * These will be merged with alchemy auto-tags (alchemy::stack, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface InternetGateway extends Resource<
  "AWS.EC2.InternetGateway",
  InternetGatewayProps,
  {
    /**
     * The ID of the internet gateway.
     */
    internetGatewayId: InternetGatewayId;
    /**
     * The Amazon Resource Name (ARN) of the internet gateway.
     */
    internetGatewayArn: `arn:aws:ec2:${RegionID}:${AccountID}:internet-gateway/${string}`;
    /**
     * The ID of the VPC the internet gateway is attached to (if any).
     */
    vpcId?: VpcId;
    /**
     * The ID of the AWS account that owns the internet gateway.
     */
    ownerId?: string;
    /**
     * The attachments for the internet gateway.
     */
    attachments?: Array<{
      state: "attaching" | "available" | "detaching" | "detached";
      vpcId: string;
    }>;
  },
  never,
  Providers
> {}
export const InternetGateway = Resource<InternetGateway>(
  "AWS.EC2.InternetGateway",
);

export const InternetGatewayProvider = () =>
  Provider.effect(
    InternetGateway,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      return {
        stables: ["internetGatewayId", "internetGatewayArn", "ownerId"],

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const alchemyTags = yield* createInternalTags(id);
          const desiredTags = { ...alchemyTags, ...(news.tags ?? {}) };

          // Observe — find the IGW via cached id, else fall through to create.
          let igw: ec2.InternetGateway | undefined;
          if (output?.internetGatewayId) {
            const lookup = yield* ec2
              .describeInternetGateways({
                InternetGatewayIds: [output.internetGatewayId],
              })
              .pipe(
                Effect.catchTag("InvalidInternetGatewayID.NotFound", () =>
                  Effect.succeed({ InternetGateways: [] }),
                ),
              );
            igw = lookup.InternetGateways?.[0];
          }

          // Ensure — create the IGW if missing.
          if (igw === undefined) {
            const createResult = yield* ec2.createInternetGateway({
              TagSpecifications: [
                {
                  ResourceType: "internet-gateway",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const newIgwId = createResult.InternetGateway!
              .InternetGatewayId! as InternetGatewayId;
            yield* session.note(`Internet gateway created: ${newIgwId}`);
            igw = yield* describeInternetGateway(newIgwId, session);
          }

          const internetGatewayId = igw.InternetGatewayId! as InternetGatewayId;

          // Sync VPC attachment — observed attachment vs desired.
          const attachedVpcId = igw.Attachments?.find(
            (a) => a.State === "available" || a.State === "attaching",
          )?.VpcId;
          if (attachedVpcId !== news.vpcId) {
            if (attachedVpcId) {
              yield* ec2
                .detachInternetGateway({
                  InternetGatewayId: internetGatewayId,
                  VpcId: attachedVpcId,
                })
                .pipe(
                  Effect.catchTag("Gateway.NotAttached", () => Effect.void),
                );
              yield* session.note(`Detached from VPC: ${attachedVpcId}`);
            }
            if (news.vpcId) {
              yield* ec2
                .attachInternetGateway({
                  InternetGatewayId: internetGatewayId,
                  VpcId: news.vpcId,
                })
                .pipe(
                  Effect.retry({
                    while: (e) => e._tag === "InvalidVpcID.NotFound",
                    schedule: Schedule.exponential(100),
                  }),
                );
              yield* session.note(`Attached to VPC: ${news.vpcId}`);
            }
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (igw.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [internetGatewayId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [internetGatewayId],
              Tags: upsert,
            });
          }

          // Re-read final state.
          const final = yield* describeInternetGateway(
            internetGatewayId,
            session,
          );
          return {
            internetGatewayId,
            internetGatewayArn: `arn:aws:ec2:${region}:${accountId}:internet-gateway/${internetGatewayId}`,
            vpcId: news.vpcId,
            ownerId: final.OwnerId,
            attachments: final.Attachments?.map((a) => ({
              state: a.State! as
                | "attaching"
                | "available"
                | "detaching"
                | "detached",
              vpcId: a.VpcId!,
            })),
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const internetGatewayId = output.internetGatewayId;

          yield* session.note(
            `Deleting internet gateway: ${internetGatewayId}`,
          );

          // Re-describe to get current attachments from AWS (don't rely on stored state)
          // This handles cases where state is incomplete from a previous crashed run
          const igw = yield* describeInternetGateway(
            internetGatewayId,
            session,
          ).pipe(Effect.catch(() => Effect.succeed({ Attachments: [] })));
          const attachments = igw.Attachments ?? [];

          // 1. Detach from all VPCs first
          if (attachments.length > 0) {
            for (const attachment of attachments) {
              yield* ec2
                .detachInternetGateway({
                  InternetGatewayId: internetGatewayId,
                  VpcId: attachment.VpcId!,
                })
                .pipe(
                  Effect.tapError(Effect.logDebug),
                  Effect.catchTag("Gateway.NotAttached", () => Effect.void),
                  Effect.catchTag(
                    "InvalidInternetGatewayID.NotFound",
                    () => Effect.void,
                  ),
                  // Retry on dependency violations (e.g., NAT Gateway with EIP still attached)
                  Effect.retry({
                    while: (e) => {
                      return e._tag === "DependencyViolation";
                    },
                    schedule: Schedule.fixed(5000).pipe(
                      Schedule.both(Schedule.recurs(60)), // Up to 5 minutes
                      Schedule.tapOutput(([, attempt]) =>
                        session.note(
                          `Waiting for VPC dependencies to clear before detaching... (attempt ${attempt + 1})`,
                        ),
                      ),
                    ),
                  }),
                );
              yield* session.note(`Detached from VPC: ${attachment.VpcId}`);
            }
          }

          // 2. Delete the internet gateway
          yield* ec2
            .deleteInternetGateway({
              InternetGatewayId: internetGatewayId,
              DryRun: false,
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.catchTag(
                "InvalidInternetGatewayID.NotFound",
                () => Effect.void,
              ),
              // Retry on dependency violations
              Effect.retry({
                while: (e) => {
                  return (
                    e._tag === "DependencyViolation" ||
                    (e._tag === "ValidationError" &&
                      e.message?.includes("DependencyViolation"))
                  );
                },
                schedule: Schedule.fixed(5000).pipe(
                  Schedule.both(Schedule.recurs(60)), // Up to 5 minutes
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          // 3. Wait for internet gateway to be fully deleted
          yield* waitForInternetGatewayDeleted(internetGatewayId, session);

          yield* session.note(
            `Internet gateway ${internetGatewayId} deleted successfully`,
          );
        }),
      };
    }),
  );

/**
 * Describe an internet gateway by ID
 */
const describeInternetGateway = (
  internetGatewayId: string,
  _session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeInternetGateways({ InternetGatewayIds: [internetGatewayId] })
      .pipe(
        Effect.catchTag("InvalidInternetGatewayID.NotFound", () =>
          Effect.succeed({ InternetGateways: [] }),
        ),
      );

    const igw = result.InternetGateways?.[0];
    if (!igw) {
      return yield* Effect.fail(new Error("Internet gateway not found"));
    }
    return igw;
  });

/**
 * Wait for internet gateway to be deleted
 */
const waitForInternetGatewayDeleted = (
  internetGatewayId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* Effect.retry(
      Effect.gen(function* () {
        const result = yield* ec2
          .describeInternetGateways({ InternetGatewayIds: [internetGatewayId] })
          .pipe(
            Effect.tapError(Effect.logDebug),
            Effect.catchTag("InvalidInternetGatewayID.NotFound", () =>
              Effect.succeed({ InternetGateways: [] }),
            ),
          );

        if (!result.InternetGateways || result.InternetGateways.length === 0) {
          return; // Successfully deleted
        }

        // Still exists, fail to trigger retry
        return yield* Effect.fail(new Error("Internet gateway still exists"));
      }),
      {
        schedule: Schedule.fixed(2000).pipe(
          Schedule.both(Schedule.recurs(15)),
          Schedule.tapOutput(([, attempt]) =>
            session.note(
              `Waiting for internet gateway deletion... (${(attempt + 1) * 2}s)`,
            ),
          ),
        ),
      },
    );
  });
