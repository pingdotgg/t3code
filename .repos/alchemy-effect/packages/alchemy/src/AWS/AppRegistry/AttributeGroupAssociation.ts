import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface AttributeGroupAssociationProps {
  /**
   * The application to associate the attribute group with: its ID, name, or
   * ARN. Changing it replaces the association.
   */
  application: string;
  /**
   * The attribute group to associate: its ID, name, or ARN. Changing it
   * replaces the association.
   */
  attributeGroup: string;
}

export interface AttributeGroupAssociation extends Resource<
  "AWS.AppRegistry.AttributeGroupAssociation",
  AttributeGroupAssociationProps,
  {
    /** The ID of the associated application. */
    applicationId: string;
    /** The ARN of the associated application. */
    applicationArn: string;
    /** The ID of the associated attribute group. */
    attributeGroupId: string;
    /** The ARN of the associated attribute group. */
    attributeGroupArn: string;
  },
  never,
  Providers
> {}

/**
 * Associates an AppRegistry {@link AttributeGroup} with an
 * {@link Application} so the group's user-defined JSON metadata augments the
 * application's machine-readable description.
 *
 * @resource
 * @section Associating an Attribute Group
 * @example Attach an Attribute Group to an Application
 * ```typescript
 * import * as AppRegistry from "alchemy/AWS/AppRegistry";
 *
 * const app = yield* AppRegistry.Application("Storefront", {});
 * const group = yield* AppRegistry.AttributeGroup("Ownership", {
 *   attributes: { owner: "commerce-team" },
 * });
 *
 * const association = yield* AppRegistry.AttributeGroupAssociation("Assoc", {
 *   application: app.applicationId,
 *   attributeGroup: group.attributeGroupId,
 * });
 * ```
 */
export const AttributeGroupAssociation = Resource<AttributeGroupAssociation>(
  "AWS.AppRegistry.AttributeGroupAssociation",
);

export const AttributeGroupAssociationProvider = () =>
  Provider.effect(
    AttributeGroupAssociation,
    Effect.gen(function* () {
      // getApplication / getAttributeGroup both accept a name, ID, or ARN.
      const observeApplication = Effect.fn(function* (specifier: string) {
        return yield* appregistry
          .getApplication({ application: specifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });
      const observeAttributeGroup = Effect.fn(function* (specifier: string) {
        return yield* appregistry
          .getAttributeGroup({ attributeGroup: specifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const isAssociated = Effect.fn(function* (
        applicationId: string,
        attributeGroupId: string,
      ) {
        const groupIds = yield* appregistry.listAssociatedAttributeGroups
          .pages({ application: applicationId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.attributeGroups ?? []),
            ),
          );
        return groupIds.includes(attributeGroupId);
      });

      return AttributeGroupAssociation.Provider.of({
        stables: [
          "applicationId",
          "applicationArn",
          "attributeGroupId",
          "attributeGroupArn",
        ],
        // The application/attribute-group pair IS the association's identity —
        // changing either side replaces the association.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            (olds.application !== news.application ||
              olds.attributeGroup !== news.attributeGroup)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const applicationSpecifier =
            output?.applicationId ?? olds?.application;
          const attributeGroupSpecifier =
            output?.attributeGroupId ?? olds?.attributeGroup;
          if (
            applicationSpecifier === undefined ||
            attributeGroupSpecifier === undefined
          ) {
            return undefined;
          }
          const application = yield* observeApplication(applicationSpecifier);
          if (application?.id === undefined) return undefined;
          const attributeGroup = yield* observeAttributeGroup(
            attributeGroupSpecifier,
          );
          if (attributeGroup?.id === undefined) return undefined;
          if (!(yield* isAssociated(application.id, attributeGroup.id))) {
            return undefined;
          }
          // Associations cannot carry tags; existence between our two parents
          // is the ownership signal.
          return {
            applicationId: application.id,
            applicationArn: application.arn!,
            attributeGroupId: attributeGroup.id,
            attributeGroupArn: attributeGroup.arn!,
          };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // 1. OBSERVE — resolve both sides to canonical IDs; a missing parent
          // surfaces its typed ResourceNotFoundException.
          const application = yield* appregistry.getApplication({
            application: news.application,
          });
          const attributeGroup = yield* appregistry.getAttributeGroup({
            attributeGroup: news.attributeGroup,
          });
          const applicationId = application.id!;
          const attributeGroupId = attributeGroup.id!;

          // 2. ENSURE — associate when missing; a ConflictException is a
          // concurrent-associate race, not a failure.
          if (!(yield* isAssociated(applicationId, attributeGroupId))) {
            yield* appregistry
              .associateAttributeGroup({
                application: applicationId,
                attributeGroup: attributeGroupId,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
          }

          yield* session.note(`${applicationId}/${attributeGroupId}`);
          return {
            applicationId,
            applicationArn: application.arn!,
            attributeGroupId,
            attributeGroupArn: attributeGroup.arn!,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* appregistry
            .disassociateAttributeGroup({
              application: output.applicationId,
              attributeGroup: output.attributeGroupId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const applications = yield* appregistry.listApplications
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.applications ?? []),
                ),
              );
            const results: {
              applicationId: string;
              applicationArn: string;
              attributeGroupId: string;
              attributeGroupArn: string;
            }[] = [];
            for (const application of applications) {
              if (application.id === undefined) continue;
              const groupIds = yield* appregistry.listAssociatedAttributeGroups
                .pages({ application: application.id })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap(
                      (page) => page.attributeGroups ?? [],
                    ),
                  ),
                );
              for (const attributeGroupId of groupIds) {
                results.push({
                  applicationId: application.id,
                  applicationArn: application.arn!,
                  attributeGroupId,
                  attributeGroupArn: `arn:aws:servicecatalog:${region}:${accountId}:/attribute-groups/${attributeGroupId}`,
                });
              }
            }
            return results;
          }),
      });
    }),
  );
