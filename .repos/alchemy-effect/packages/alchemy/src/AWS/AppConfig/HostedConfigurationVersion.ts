import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface HostedConfigurationVersionProps {
  /**
   * ID of the application. Changing it replaces the version.
   */
  applicationId: string;
  /**
   * ID of the (hosted) configuration profile. Changing it replaces the
   * version.
   */
  configurationProfileId: string;
  /**
   * The configuration content itself — the YAML/JSON/text document served to
   * clients. Hosted configuration versions are immutable; changing the
   * content creates a new version (a replacement).
   */
  content: string;
  /**
   * MIME type of the content, e.g. `application/json`, `application/x-yaml`,
   * or `text/plain`.
   */
  contentType: string;
  /**
   * Description of the configuration version.
   */
  description?: string;
  /**
   * A user-defined label for the version (e.g. a git SHA). Must be unique per
   * profile.
   */
  versionLabel?: string;
}

export interface HostedConfigurationVersion extends Resource<
  "AWS.AppConfig.HostedConfigurationVersion",
  HostedConfigurationVersionProps,
  {
    applicationId: string;
    configurationProfileId: string;
    versionNumber: number;
    contentType: string;
    versionLabel: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig hosted configuration version — the actual configuration
 * content stored in the AppConfig hosted store. Versions are immutable: each
 * change to the content produces a new version (a replacement), and its
 * `versionNumber` is what you deploy through a {@link Deployment}.
 *
 * @resource
 * @section Creating a Hosted Configuration Version
 * @example JSON Configuration
 * ```typescript
 * const version = yield* AppConfig.HostedConfigurationVersion("V1", {
 *   applicationId: app.applicationId,
 *   configurationProfileId: profile.configurationProfileId,
 *   content: JSON.stringify({ featureX: true }),
 *   contentType: "application/json",
 * });
 * // version.versionNumber -> 1
 * ```
 */
export const HostedConfigurationVersion = Resource<HostedConfigurationVersion>(
  "AWS.AppConfig.HostedConfigurationVersion",
);

export const HostedConfigurationVersionProvider = () =>
  Provider.effect(
    HostedConfigurationVersion,
    Effect.gen(function* () {
      const readVersion = Effect.fn(function* (
        applicationId: string,
        configurationProfileId: string,
        versionNumber: number,
      ) {
        return yield* appconfig
          .getHostedConfigurationVersion({
            ApplicationId: applicationId,
            ConfigurationProfileId: configurationProfileId,
            VersionNumber: versionNumber,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["applicationId", "configurationProfileId", "versionNumber"],

        // Hosted configuration versions are immutable and content-addressed —
        // any change produces a fresh version.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            (olds.applicationId !== news.applicationId ||
              olds.configurationProfileId !== news.configurationProfileId ||
              olds.content !== news.content ||
              olds.contentType !== news.contentType ||
              (olds.description ?? undefined) !==
                (news.description ?? undefined) ||
              (olds.versionLabel ?? undefined) !==
                (news.versionLabel ?? undefined))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ output }) {
          if (output?.versionNumber === undefined) return undefined;
          const version = yield* readVersion(
            output.applicationId,
            output.configurationProfileId,
            output.versionNumber,
          );
          if (version?.VersionNumber === undefined) return undefined;
          return {
            applicationId: output.applicationId,
            configurationProfileId: output.configurationProfileId,
            versionNumber: version.VersionNumber,
            contentType: version.ContentType ?? output.contentType,
            versionLabel: version.VersionLabel,
          };
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe — the version may already exist (crash-resumed create).
          const existing =
            output?.versionNumber !== undefined
              ? yield* readVersion(
                  output.applicationId,
                  output.configurationProfileId,
                  output.versionNumber,
                )
              : undefined;

          if (existing?.VersionNumber !== undefined) {
            yield* session.note(`version-${existing.VersionNumber}`);
            return {
              applicationId: news.applicationId,
              configurationProfileId: news.configurationProfileId,
              versionNumber: existing.VersionNumber,
              contentType: existing.ContentType ?? news.contentType,
              versionLabel: existing.VersionLabel,
            };
          }

          const created = yield* appconfig.createHostedConfigurationVersion({
            ApplicationId: news.applicationId,
            ConfigurationProfileId: news.configurationProfileId,
            Content: news.content,
            ContentType: news.contentType,
            Description: news.description,
            VersionLabel: news.versionLabel,
          });

          yield* session.note(`version-${created.VersionNumber}`);
          return {
            applicationId: news.applicationId,
            configurationProfileId: news.configurationProfileId,
            versionNumber: created.VersionNumber!,
            contentType: created.ContentType ?? news.contentType,
            versionLabel: created.VersionLabel,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appconfig
            .deleteHostedConfigurationVersion({
              ApplicationId: output.applicationId,
              ConfigurationProfileId: output.configurationProfileId,
              VersionNumber: output.versionNumber,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Hosted configuration versions are keyed under their parent profile.
        list: () => Effect.succeed([]),
      };
    }),
  );
