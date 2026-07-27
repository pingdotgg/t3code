import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
} from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { getDefaultVpcScope } from "./defaultVpcScope.ts";
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
/**
 * An internet gateway provides a target for internet-routable traffic in a
 * VPC, enabling bidirectional IPv4 and IPv6 connectivity between resources in
 * your VPC and the public internet. A VPC can have at most one internet
 * gateway attached at a time.
 *
 * The only inputs are the optional `vpcId` to attach to and `tags`. Attaching a
 * gateway is not enough on its own to make a subnet public — you also need a
 * `0.0.0.0/0` {@link Route} pointing at the gateway and a
 * {@link RouteTableAssociation} binding the subnet to that route table.
 *
 * @resource
 * @section Creating an Internet Gateway
 * Pass `vpcId` to create and attach the gateway in one step, or omit it to
 * create a standalone gateway and attach it later by setting the prop. Updating
 * `vpcId` moves the gateway between VPCs (detach then attach) without
 * recreating it.
 *
 * @example Internet Gateway Attached to a VPC
 * ```typescript
 * const internetGateway = yield* AWS.EC2.InternetGateway("InternetGateway", {
 *   vpcId: myVpc.vpcId,
 * });
 * ```
 * Creates the gateway and attaches it to the VPC immediately. The resulting
 * `internetGatewayId` (prefixed `igw-`) is what you reference from a route's
 * `gatewayId`.
 *
 * @example Detached Internet Gateway
 * ```typescript
 * const internetGateway = yield* AWS.EC2.InternetGateway("InternetGateway", {});
 * ```
 * Omitting `vpcId` creates an unattached gateway. This is occasionally useful
 * when the VPC is provisioned separately; add the `vpcId` prop later to attach
 * it.
 *
 * @example Internet Gateway with Tags
 * ```typescript
 * const internetGateway = yield* AWS.EC2.InternetGateway("InternetGateway", {
 *   vpcId: myVpc.vpcId,
 *   tags: { Name: "production-igw" },
 * });
 * ```
 * The `tags` map is merged with the alchemy auto-tags and can be changed in
 * place. A `Name` tag makes the gateway easy to identify in the AWS console.
 *
 * @section Enabling Public Internet Access
 * An internet gateway only carries traffic once a route table sends traffic to
 * it and a subnet is associated with that table. The full pattern below makes a
 * subnet public.
 *
 * @example Internet Gateway with a Default Route
 * ```typescript
 * const internetGateway = yield* AWS.EC2.InternetGateway("InternetGateway", {
 *   vpcId: myVpc.vpcId,
 * });
 *
 * const publicRouteTable = yield* AWS.EC2.RouteTable("PublicRouteTable", {
 *   vpcId: myVpc.vpcId,
 * });
 *
 * const internetRoute = yield* AWS.EC2.Route("InternetRoute", {
 *   routeTableId: publicRouteTable.routeTableId,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   gatewayId: internetGateway.internetGatewayId,
 * });
 * ```
 * With the default route in place, any subnet associated with
 * `publicRouteTable` can send and receive internet traffic. Add an analogous
 * route with `destinationIpv6CidrBlock: "::/0"` to enable IPv6.
 */
export const InternetGateway = Resource<InternetGateway>(
  "AWS.EC2.InternetGateway",
);

export const InternetGatewayProvider = () =>
  Provider.effect(
    InternetGateway,
    Effect.gen(function* () {
      const findInternetGatewayByTags = Effect.fn(function* (id: string) {
        const filters = yield* createAlchemyTagFilters(id);
        const pages = yield* ec2.describeInternetGateways
          .pages({ Filters: filters })
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.InternetGateways ?? [])
          .find((candidate) => candidate.InternetGatewayId !== undefined);
      });

      return {
        stables: ["internetGatewayId", "internetGatewayArn", "ownerId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            // The default VPC's internet gateway is account furniture AWS
            // provisions; never census/nuke it.
            const defaultVpc = yield* getDefaultVpcScope;
            return yield* ec2.describeInternetGateways.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.InternetGateways ?? [])
                    .filter(
                      (
                        igw,
                      ): igw is ec2.InternetGateway & {
                        InternetGatewayId: string;
                      } => igw.InternetGatewayId != null,
                    )
                    .filter(
                      (igw) =>
                        defaultVpc.vpcId === undefined ||
                        !igw.Attachments?.some(
                          (a) => a.VpcId === defaultVpc.vpcId,
                        ),
                    )
                    .map((igw) => {
                      const internetGatewayId =
                        igw.InternetGatewayId as InternetGatewayId;
                      const attachedVpcId = igw.Attachments?.find(
                        (a) =>
                          a.State === "available" || a.State === "attaching",
                      )?.VpcId as VpcId | undefined;
                      return {
                        internetGatewayId,
                        internetGatewayArn:
                          `arn:aws:ec2:${region}:${accountId}:internet-gateway/${internetGatewayId}` as const,
                        vpcId: attachedVpcId,
                        ownerId: igw.OwnerId,
                        attachments: igw.Attachments?.map((a) => ({
                          state: a.State! as
                            | "attaching"
                            | "available"
                            | "detaching"
                            | "detached",
                          vpcId: a.VpcId!,
                        })),
                      };
                    }),
                ),
              ),
            );
          }),

        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news = {},
          output,
          session,
        }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const alchemyTags = yield* createInternalTags(id);
          const desiredTags = {
            ...news.tags,
            ...alchemyTags,
            "alchemy::instance": instanceId,
          };

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
          if (igw === undefined) {
            // CreateInternetGateway has no idempotency token and this provider
            // never replaces an IGW. Recover a create that succeeded before
            // state persistence by stable stack/stage/logical-id ownership.
            // Older interrupted creates predate the instance tag, so requiring
            // it here would strand exactly the resources recovery must adopt.
            igw = yield* findInternetGatewayByTags(id);
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
            // EC2 can return the new ID before DescribeInternetGateways sees
            // it. Retain and poll that ID rather than failing the reconcile
            // after creation and losing the cleanup handle.
            igw = yield* describeInternetGateway(newIgwId);
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
                    while: (e) =>
                      e._tag === "InvalidVpcID.NotFound" ||
                      e._tag === "InvalidInternetGatewayID.NotFound",
                    schedule: Schedule.max([
                      Schedule.fixed(500),
                      Schedule.recurs(10),
                    ]),
                  }),
                );
              yield* session.note(`Attached to VPC: ${news.vpcId}`);
            }
          }
          if (news.vpcId) {
            // AttachInternetGateway is asynchronous. Also check this when the
            // observed attachment was already `attaching`, as can happen when
            // a reconcile resumes after interruption. Do not publish outputs
            // to a dependent Route until AWS reports it as available.
            igw = yield* waitForInternetGatewayAttached(
              internetGatewayId,
              news.vpcId,
              session,
            );
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
          const final = yield* describeInternetGateway(internetGatewayId);
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
          const igw = yield* findInternetGateway(internetGatewayId);
          if (igw === undefined) {
            yield* session.note(
              `Internet gateway ${internetGatewayId} is already absent`,
            );
            return;
          }
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
                    // Public addresses on a draining EKS/HyperPod control
                    // plane's ENIs can take several minutes to release —
                    // 5s x 60 = ~5 min.
                    schedule: Schedule.max([
                      Schedule.fixed(5000),
                      Schedule.recurs(60),
                    ]).pipe(
                      Schedule.tap(({ attempt }) =>
                        session.note(
                          `Waiting for VPC dependencies to clear before detaching... (attempt ${attempt})`,
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
              // Retry on dependency violations. Public addresses on a
              // draining EKS/HyperPod control plane's ENIs can take
              // several minutes to release — 5s x 60 = ~5 min.
              Effect.retry({
                while: (e) => {
                  return (
                    e._tag === "DependencyViolation" ||
                    (e._tag === "ValidationError" &&
                      e.message?.includes("DependencyViolation"))
                  );
                },
                schedule: Schedule.max([
                  Schedule.fixed(5000),
                  Schedule.recurs(60),
                ]).pipe(
                  Schedule.tap(({ attempt }) =>
                    session.note(
                      `Waiting for dependencies to clear... (attempt ${attempt})`,
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
const findInternetGateway = (internetGatewayId: string) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeInternetGateways({ InternetGatewayIds: [internetGatewayId] })
      .pipe(
        Effect.catchTag("InvalidInternetGatewayID.NotFound", () =>
          Effect.succeed({ InternetGateways: [] }),
        ),
      );

    return result.InternetGateways?.[0];
  });

const describeInternetGateway = (internetGatewayId: string) =>
  findInternetGateway(internetGatewayId).pipe(
    Effect.flatMap((igw) =>
      igw
        ? Effect.succeed(igw)
        : Effect.fail(new InternetGatewayNotVisible({ internetGatewayId })),
    ),
    Effect.retry({
      while: (error) => error instanceof InternetGatewayNotVisible,
      schedule: Schedule.max([Schedule.fixed(500), Schedule.recurs(10)]),
    }),
  );

class InternetGatewayNotVisible extends Data.TaggedError(
  "InternetGatewayNotVisible",
)<{
  internetGatewayId: string;
}> {}

class InternetGatewayAttachmentPending extends Data.TaggedError(
  "InternetGatewayAttachmentPending",
)<{
  internetGatewayId: string;
  vpcId: string;
  state: string;
}> {}

const waitForInternetGatewayAttached = (
  internetGatewayId: string,
  vpcId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const igw = yield* describeInternetGateway(internetGatewayId);
    const attachment = igw.Attachments?.find(
      (candidate) => candidate.VpcId === vpcId,
    );
    if (attachment?.State === "available") {
      return igw;
    }
    return yield* new InternetGatewayAttachmentPending({
      internetGatewayId,
      vpcId,
      state: attachment?.State ?? "missing",
    });
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof InternetGatewayAttachmentPending,
      schedule: Schedule.max([Schedule.fixed(1000), Schedule.recurs(30)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for internet gateway attachment to become available... (${attempt}s)`,
          ),
        ),
      ),
    }),
  );

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
        schedule: Schedule.max([
          Schedule.fixed(2000),
          Schedule.recurs(15),
        ]).pipe(
          Schedule.tap(({ attempt }) =>
            session.note(
              `Waiting for internet gateway deletion... (${attempt * 2}s)`,
            ),
          ),
        ),
      },
    );
  });
