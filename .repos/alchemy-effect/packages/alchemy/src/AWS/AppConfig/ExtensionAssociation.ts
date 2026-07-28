import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  extensionAssociationArn,
  readAppConfigTags,
  syncAppConfigTags,
  toTagRecord,
} from "./internal.ts";

export interface ExtensionAssociationProps {
  /**
   * The extension to associate: its ID, name, or ARN. Changing it replaces
   * the association.
   */
  extensionIdentifier: string;
  /**
   * The version of the extension to pin. If omitted, AppConfig uses the
   * latest version. Changing it replaces the association.
   */
  extensionVersionNumber?: number;
  /**
   * ARN of the AppConfig resource the extension attaches to: an application,
   * environment, or configuration profile. Changing it replaces the
   * association.
   */
  resourceIdentifier: string;
  /**
   * Values for the parameters declared by the extension, keyed by parameter
   * name.
   */
  parameters?: Record<string, string>;
  /**
   * User-defined tags for the extension association.
   */
  tags?: Record<string, string>;
}

export interface ExtensionAssociation extends Resource<
  "AWS.AppConfig.ExtensionAssociation",
  ExtensionAssociationProps,
  {
    extensionAssociationId: string;
    extensionAssociationArn: string;
    extensionArn: string;
    resourceArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig extension association — attaches an {@link Extension} to an
 * application, environment, or configuration profile so the extension's
 * actions fire for that resource's workflow events.
 *
 * @resource
 * @section Associating an Extension
 * @example Attach an Extension to an Application
 * ```typescript
 * const association = yield* AppConfig.ExtensionAssociation("Hook", {
 *   extensionIdentifier: extension.extensionId,
 *   resourceIdentifier: app.applicationArn,
 * });
 * ```
 *
 * @example Attach with Parameter Values
 * ```typescript
 * const association = yield* AppConfig.ExtensionAssociation("Hook", {
 *   extensionIdentifier: extension.extensionId,
 *   resourceIdentifier: env.environmentArn,
 *   parameters: { topicArn: topic.topicArn },
 * });
 * ```
 */
export const ExtensionAssociation = Resource<ExtensionAssociation>(
  "AWS.AppConfig.ExtensionAssociation",
);

export const ExtensionAssociationProvider = () =>
  Provider.effect(
    ExtensionAssociation,
    Effect.gen(function* () {
      const readAssociation = Effect.fn(function* (
        extensionAssociationId: string,
      ) {
        return yield* appconfig
          .getExtensionAssociation({
            ExtensionAssociationId: extensionAssociationId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /**
       * Find an existing association between the extension and the resource
       * (associations have no name; the pair is the natural identity).
       *
       * `ListExtensionAssociations` rejects requests carrying BOTH
       * `ExtensionIdentifier` and `ResourceIdentifier` ("Request cannot
       * contain both..."), so list by resource and match the extension
       * client-side via its resolved id (association `ExtensionArn`s are
       * versioned, `.../extension/{id}/{version}`).
       */
      const findByIdentifiers = Effect.fn(function* (
        props: Partial<ExtensionAssociationProps>,
      ) {
        if (
          props.extensionIdentifier === undefined ||
          props.resourceIdentifier === undefined
        ) {
          return undefined;
        }
        const extension = yield* appconfig
          .getExtension({ ExtensionIdentifier: props.extensionIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (extension?.Id === undefined) return undefined;
        const summaries = yield* appconfig.listExtensionAssociations
          .pages({ ResourceIdentifier: props.resourceIdentifier })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Items ?? []),
            ),
          );
        const summary = summaries.find(
          (item) =>
            item.Id !== undefined &&
            item.ExtensionArn !== undefined &&
            item.ExtensionArn.includes(extension.Id!),
        );
        return summary?.Id === undefined
          ? undefined
          : yield* readAssociation(summary.Id);
      });

      const toAttrs = Effect.fn(function* (
        association: appconfig.ExtensionAssociation,
      ) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return {
          extensionAssociationId: association.Id!,
          extensionAssociationArn:
            association.Arn ??
            extensionAssociationArn(region, accountId, association.Id!),
          extensionArn: association.ExtensionArn!,
          resourceArn: association.ResourceArn!,
        };
      });

      return {
        stables: [
          "extensionAssociationId",
          "extensionAssociationArn",
          "extensionArn",
          "resourceArn",
        ],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            (olds.extensionIdentifier !== news.extensionIdentifier ||
              olds.resourceIdentifier !== news.resourceIdentifier ||
              (olds.extensionVersionNumber ?? undefined) !==
                (news.extensionVersionNumber ?? undefined))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const association = output?.extensionAssociationId
            ? yield* readAssociation(output.extensionAssociationId)
            : yield* findByIdentifiers(olds ?? {});
          if (association?.Id === undefined) return undefined;
          const attrs = yield* toAttrs(association);
          const tags = yield* readAppConfigTags(attrs.extensionAssociationArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = output?.extensionAssociationId
            ? yield* readAssociation(output.extensionAssociationId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByIdentifiers(news);
          }

          // 2. Ensure.
          if (observed?.Id === undefined) {
            observed = yield* appconfig.createExtensionAssociation({
              ExtensionIdentifier: news.extensionIdentifier,
              ExtensionVersionNumber: news.extensionVersionNumber,
              ResourceIdentifier: news.resourceIdentifier,
              Parameters: news.parameters,
              Tags: desiredTags,
            });
          } else {
            // 3. Sync — parameter values are mutable in place.
            const observedParameters = toTagRecord(observed.Parameters);
            const desiredParameters = news.parameters ?? {};
            const { removed, upsert } = diffTags(
              observedParameters,
              desiredParameters,
            );
            if (removed.length > 0 || upsert.length > 0) {
              observed = yield* appconfig.updateExtensionAssociation({
                ExtensionAssociationId: observed.Id,
                Parameters: desiredParameters,
              });
            }
          }

          const attrs = yield* toAttrs(observed);

          // 3b. Sync tags against observed cloud tags.
          yield* syncAppConfigTags(attrs.extensionAssociationArn, desiredTags);

          yield* session.note(attrs.extensionAssociationId);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appconfig
            .deleteExtensionAssociation({
              ExtensionAssociationId: output.extensionAssociationId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const summaries = yield* appconfig.listExtensionAssociations
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.Items ?? []),
                ),
              );
            return summaries.flatMap((summary) =>
              summary.Id !== undefined &&
              summary.ExtensionArn !== undefined &&
              summary.ResourceArn !== undefined
                ? [
                    {
                      extensionAssociationId: summary.Id,
                      extensionAssociationArn: extensionAssociationArn(
                        region,
                        accountId,
                        summary.Id,
                      ),
                      extensionArn: summary.ExtensionArn,
                      resourceArn: summary.ResourceArn,
                    },
                  ]
                : [],
            );
          }),
      };
    }),
  );
