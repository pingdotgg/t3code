import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { clientToken, stripAwsSystemTags } from "./internal.ts";

export interface ApplicationProps {
  /**
   * Name of the application. Must be unique in the account and region and
   * may only contain letters, numbers, dots, dashes, and underscores.
   * If omitted, a unique name is generated. Changing it replaces the
   * application.
   */
  applicationName?: string;
  /**
   * Description of the application. Updatable in place.
   */
  description?: string;
  /**
   * Tags to apply to the application. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "AWS.AppRegistry.Application",
  ApplicationProps,
  {
    /** The auto-generated application ID. */
    applicationId: string;
    /** The ARN of the application. */
    applicationArn: string;
    /** The name of the application. */
    applicationName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Service Catalog AppRegistry application — the top-level node that
 * groups related cloud resources and metadata under a single logical
 * application (surfaced in myApplications and the `awsApplication` tag).
 *
 * @resource
 * @section Creating an Application
 * @example Basic Application
 * ```typescript
 * import * as AppRegistry from "alchemy/AWS/AppRegistry";
 *
 * const app = yield* AppRegistry.Application("Storefront", {});
 * ```
 *
 * @example Application with Description and Tags
 * ```typescript
 * const app = yield* AppRegistry.Application("Storefront", {
 *   applicationName: "storefront",
 *   description: "Customer-facing storefront services",
 *   tags: { team: "commerce" },
 * });
 * ```
 */
export const Application = Resource<Application>("AWS.AppRegistry.Application");

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ApplicationProps, "applicationName">,
      ) {
        return (
          props.applicationName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      // getApplication accepts a name, ID, or ARN specifier.
      const observe = Effect.fn(function* (specifier: string) {
        return yield* appregistry
          .getApplication({ application: specifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Application.Provider.of({
        stables: ["applicationId", "applicationArn", "applicationName"],
        list: () =>
          appregistry.listApplications.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.applications ?? [])
                .filter((a) => a.id != null && a.arn != null && a.name != null)
                .map((a) => ({
                  applicationId: a.id!,
                  applicationArn: a.arn!,
                  applicationName: a.name!,
                })),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const specifier =
            output?.applicationId ?? (yield* createName(id, olds ?? {}));
          const found = yield* observe(specifier);
          if (!found?.id) return undefined;
          const attrs = {
            applicationId: found.id,
            applicationArn: found.arn!,
            applicationName: found.name!,
          };
          return (yield* hasAlchemyTags(id, tagRecord(found.tags)))
            ? attrs
            : Unowned(attrs);
        }),
        // The application name is its user-facing identity — changing it
        // replaces the application.
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          instanceId,
        }) {
          const applicationName = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };

          // 1. OBSERVE — cloud is authoritative; output caches the ID only.
          let found = output?.applicationId
            ? yield* observe(output.applicationId)
            : undefined;
          if (!found?.id) {
            found = yield* observe(applicationName);
          }

          // 2. ENSURE — create when missing; tolerate a concurrent-create
          // race (ConflictException) by re-reading.
          if (!found?.id) {
            yield* appregistry
              .createApplication({
                name: applicationName,
                description: news.description,
                tags: desiredTags,
                clientToken: clientToken(instanceId),
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            found = yield* observe(applicationName);
          }

          const applicationId = found!.id!;
          const applicationArn = found!.arn!;

          // 3a. SYNC description — apply only when it actually changed.
          if (
            news.description !== undefined &&
            found!.description !== news.description
          ) {
            yield* appregistry.updateApplication({
              application: applicationId,
              description: news.description,
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags so adoption
          // converges.
          const observedTags = stripAwsSystemTags(tagRecord(found!.tags));
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* appregistry.tagResource({
              resourceArn: applicationArn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* appregistry.untagResource({
              resourceArn: applicationArn,
              tagKeys: removed,
            });
          }

          yield* session.note(applicationId);
          return {
            applicationId,
            applicationArn,
            applicationName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* appregistry
            .deleteApplication({ application: output.applicationId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
