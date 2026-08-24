import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  applicationArn,
  readAppConfigTags,
  syncAppConfigTags,
} from "./internal.ts";

export interface ApplicationProps {
  /**
   * Name of the application. Must be 1-64 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * application.
   */
  applicationName?: string;
  /**
   * Description of the application.
   */
  description?: string;
  /**
   * User-defined tags for the application.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "AWS.AppConfig.Application",
  ApplicationProps,
  {
    applicationId: string;
    applicationName: string;
    applicationArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig application — the top-level container that groups the
 * environments and configuration profiles for one application's configuration.
 *
 * @resource
 * @section Creating an Application
 * @example Basic Application
 * ```typescript
 * const app = yield* AppConfig.Application("MyApp", {
 *   description: "Configuration for my service",
 * });
 * ```
 *
 * @example Named Application with Tags
 * ```typescript
 * const app = yield* AppConfig.Application("MyApp", {
 *   applicationName: "my-service",
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const Application = Resource<Application>("AWS.AppConfig.Application");

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ApplicationProps>) =>
        props.applicationName
          ? Effect.succeed(props.applicationName)
          : createPhysicalName({ id, maxLength: 64 });

      /** Find an application by name (get requires the generated id). */
      const findByName = Effect.fn(function* (name: string) {
        const apps = yield* appconfig.listApplications.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.Items ?? []),
          ),
        );
        return apps.find((a) => a.Name === name);
      });

      const readApplication = Effect.fn(function* (applicationId: string) {
        return yield* appconfig
          .getApplication({ ApplicationId: applicationId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["applicationId", "applicationName", "applicationArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const app = output?.applicationId
            ? yield* readApplication(output.applicationId)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (app?.Id === undefined) return undefined;
          const arn = applicationArn(region, accountId, app.Id);
          const attrs = {
            applicationId: app.Id,
            applicationName: app.Name!,
            applicationArn: arn,
          };
          const tags = yield* readAppConfigTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.applicationName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output is only a cache.
          let observed = output?.applicationId
            ? yield* readApplication(output.applicationId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(name);
          }

          // 2. Ensure — create if missing.
          if (observed?.Id === undefined) {
            observed = yield* appconfig.createApplication({
              Name: name,
              Description: news.description,
              Tags: desiredTags,
            });
          } else if (
            news.description !== undefined &&
            observed.Description !== news.description
          ) {
            // 3. Sync — description is mutable in place.
            observed = yield* appconfig.updateApplication({
              ApplicationId: observed.Id,
              Description: news.description,
            });
          }

          const arn = applicationArn(region, accountId, observed.Id!);

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAppConfigTags(arn, desiredTags);

          yield* session.note(name);
          return {
            applicationId: observed.Id!,
            applicationName: observed.Name ?? name,
            applicationArn: arn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // An application cannot be deleted while environments or
          // configuration profiles still exist under it ("Cannot delete
          // application ..., because there are still environments existing
          // under it" — surfaced as BadRequestException). Children are
          // deleted first by the engine/nuke, but their deletion is
          // eventually consistent, so absorb the window with a bounded retry.
          yield* appconfig
            .deleteApplication({ ApplicationId: output.applicationId })
            .pipe(
              Effect.retry({
                while: (e): boolean => e._tag === "BadRequestException",
                schedule: Schedule.fixed("3 seconds"),
                times: 5,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const apps = yield* appconfig.listApplications.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Items ?? []),
              ),
            );
            return apps.flatMap((a) =>
              a.Id !== undefined && a.Name !== undefined
                ? [
                    {
                      applicationId: a.Id,
                      applicationName: a.Name,
                      applicationArn: applicationArn(region, accountId, a.Id),
                    },
                  ]
                : [],
            );
          }),
      };
    }),
  );
