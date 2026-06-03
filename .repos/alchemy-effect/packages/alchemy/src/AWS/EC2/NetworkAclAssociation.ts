import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { NetworkAclId } from "./NetworkAcl.ts";
import type { SubnetId } from "./Subnet.ts";

export type NetworkAclAssociationId<ID extends string = string> =
  `aclassoc-${ID}`;
export const NetworkAclAssociationId = <ID extends string>(
  id: ID,
): ID & NetworkAclAssociationId<ID> =>
  `aclassoc-${id}` as ID & NetworkAclAssociationId<ID>;

export interface NetworkAclAssociationProps {
  /**
   * The ID of the new network ACL to associate with the subnet.
   */
  networkAclId: NetworkAclId;

  /**
   * The ID of the subnet to associate with the network ACL.
   */
  subnetId: SubnetId;
}

export interface NetworkAclAssociation extends Resource<
  "AWS.EC2.NetworkAclAssociation",
  NetworkAclAssociationProps,
  {
    associationId: NetworkAclAssociationId;
    networkAclId: NetworkAclId;
    subnetId: SubnetId;
  },
  never,
  Providers
> {}
export const NetworkAclAssociation = Resource<NetworkAclAssociation>(
  "AWS.EC2.NetworkAclAssociation",
);

export const NetworkAclAssociationProvider = () =>
  Provider.effect(
    NetworkAclAssociation,
    Effect.gen(function* () {
      const findAssociation = (subnetId: string) =>
        ec2
          .describeNetworkAcls({
            Filters: [{ Name: "association.subnet-id", Values: [subnetId] }],
          })
          .pipe(
            Effect.map((r) => {
              const acl = r.NetworkAcls?.[0];
              const assoc = acl?.Associations?.find(
                (a) => a.SubnetId === subnetId,
              );
              return assoc
                ? {
                    associationId: assoc.NetworkAclAssociationId!,
                    networkAclId: assoc.NetworkAclId!,
                    subnetId: assoc.SubnetId!,
                  }
                : undefined;
            }),
          );

      return NetworkAclAssociation.Provider.of({
        stables: ["subnetId"],

        read: Effect.fn(function* ({ olds }) {
          if (!olds) return undefined;
          const assoc = yield* findAssociation(olds.subnetId as string);
          if (!assoc) {
            return yield* Effect.fail(
              new Error(
                `Network ACL Association not found for subnet ${olds.subnetId}`,
              ),
            );
          }
          return {
            associationId: assoc.associationId as NetworkAclAssociationId,
            networkAclId: assoc.networkAclId as NetworkAclId,
            subnetId: assoc.subnetId as SubnetId,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Subnet change requires replacement
          if (news.subnetId !== olds.subnetId) {
            return { action: "replace" };
          }
          // Network ACL change can be done via replaceNetworkAclAssociation
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe — find the subnet's current association. EC2 guarantees
          // every subnet always has exactly one NACL association, so the
          // lookup always returns something for a live subnet.
          const currentAssoc = yield* findAssociation(news.subnetId as string);
          if (!currentAssoc) {
            return yield* Effect.fail(
              new Error(
                `No existing Network ACL Association found for subnet ${news.subnetId}`,
              ),
            );
          }

          // Sync — if the subnet already points at the desired NACL, the
          // association is already correct and we just report it. Otherwise
          // ReplaceNetworkAclAssociation atomically swaps it.
          if (currentAssoc.networkAclId === (news.networkAclId as string)) {
            return {
              associationId:
                currentAssoc.associationId as NetworkAclAssociationId,
              networkAclId: news.networkAclId as NetworkAclId,
              subnetId: news.subnetId as SubnetId,
            };
          }

          yield* session.note(
            `Associating subnet ${news.subnetId} with NACL ${news.networkAclId}...`,
          );
          const result = yield* ec2.replaceNetworkAclAssociation({
            AssociationId: currentAssoc.associationId,
            NetworkAclId: news.networkAclId as string,
            DryRun: false,
          });
          const newAssociationId = result.NewAssociationId!;
          yield* session.note(`Network ACL Association: ${newAssociationId}`);
          return {
            associationId: newAssociationId as NetworkAclAssociationId,
            networkAclId: news.networkAclId as NetworkAclId,
            subnetId: news.subnetId as SubnetId,
          };
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          yield* session.note(`Deleting Network ACL Association...`);

          // When deleting, we need to associate the subnet back to the default NACL
          // Find the default NACL for the VPC
          const subnetResult = yield* ec2
            .describeSubnets({
              SubnetIds: [olds.subnetId as string],
            })
            .pipe(
              // If subnet is already deleted, association is gone too
              Effect.catchTag("InvalidSubnetID.NotFound", () =>
                Effect.succeed({ Subnets: [] }),
              ),
            );
          const vpcId = subnetResult.Subnets?.[0]?.VpcId;

          if (!vpcId) {
            // Subnet is already deleted, so the association is gone
            yield* session.note(`Subnet already deleted, association is gone`);
            return;
          }

          const defaultAclResult = yield* ec2.describeNetworkAcls({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "default", Values: ["true"] },
            ],
          });

          const defaultAclId = defaultAclResult.NetworkAcls?.[0]?.NetworkAclId;

          if (defaultAclId && defaultAclId !== (olds.networkAclId as string)) {
            // Replace with default NACL
            yield* ec2
              .replaceNetworkAclAssociation({
                AssociationId: output.associationId,
                NetworkAclId: defaultAclId,
                DryRun: false,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidAssociationID.NotFound",
                  () => Effect.void,
                ),
              );

            yield* session.note(`Network ACL Association reverted to default`);
          } else {
            yield* session.note(
              `Already using default Network ACL, nothing to do`,
            );
          }
        }),
      });
    }),
  );
