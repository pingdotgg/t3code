import * as appflow from "@distilled.cloud/aws/appflow";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ConnectorProfileProps {
  /**
   * The name of the connector profile. Unique per account/region and used as
   * the profile's identity. Changing it replaces the profile.
   */
  connectorProfileName: string;
  /**
   * The type of connector (e.g. `Salesforce`, `Redshift`, `Snowflake`). S3
   * and EventBridge do not require a connector profile.
   */
  connectorType: appflow.ConnectorType;
  /**
   * The label of the custom connector, required only for the
   * `CustomConnector` type.
   */
  connectorLabel?: string;
  /**
   * Whether the connector connects over the public internet or a private
   * PrivateLink connection.
   * @default "Public"
   */
  connectionMode?: "Public" | "Private";
  /**
   * The connector-specific properties and credentials. Credentials
   * (OAuth tokens, API keys, secrets) are supplied here — these typically
   * require a human-in-the-loop authorization step with the vendor.
   */
  connectorProfileConfig: appflow.ConnectorProfileConfig;
  /**
   * The ARN of a KMS key AppFlow uses to encrypt the stored credentials.
   */
  kmsArn?: string;
}

export interface ConnectorProfile extends Resource<
  "AWS.AppFlow.ConnectorProfile",
  ConnectorProfileProps,
  {
    connectorProfileName: string;
    connectorProfileArn: string;
    connectorType: string | undefined;
    credentialsArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon AppFlow connector profile. A connector profile stores the
 * connection settings and credentials for a SaaS/data-warehouse connector
 * (Salesforce, Snowflake, Redshift, etc.) so flows can reference it.
 *
 * Most connectors require vendor credentials obtained through a
 * human-in-the-loop OAuth or API-key step, so a connector profile's live
 * lifecycle generally cannot be created purely programmatically. S3 and
 * EventBridge flows do not need a connector profile at all.
 * @resource
 * @section Creating a Connector Profile
 * @example Redshift Connector Profile
 * ```typescript
 * const profile = yield* AppFlow.ConnectorProfile("Warehouse", {
 *   connectorProfileName: "warehouse",
 *   connectorType: "Redshift",
 *   connectionMode: "Public",
 *   connectorProfileConfig: {
 *     connectorProfileProperties: {
 *       Redshift: {
 *         databaseUrl: "jdbc:redshift://cluster:5439/db",
 *         bucketName: "appflow-staging",
 *         roleArn: role.roleArn,
 *       },
 *     },
 *     connectorProfileCredentials: {
 *       Redshift: { username: "admin", password: "..." },
 *     },
 *   },
 * });
 * ```
 */
export const ConnectorProfile = Resource<ConnectorProfile>(
  "AWS.AppFlow.ConnectorProfile",
);

export const ConnectorProfileProvider = () =>
  Provider.effect(
    ConnectorProfile,
    Effect.gen(function* () {
      /** Describe a single connector profile by name; undefined if absent. */
      const observe = (name: string) =>
        appflow
          .describeConnectorProfiles({ connectorProfileNames: [name] })
          .pipe(
            Effect.map((r) =>
              (r.connectorProfileDetails ?? []).find(
                (p) => p.connectorProfileName === name,
              ),
            ),
          );

      const toAttrs = (name: string, profile: appflow.ConnectorProfile) => ({
        connectorProfileName: name,
        connectorProfileArn: profile.connectorProfileArn!,
        connectorType: profile.connectorType,
        credentialsArn: profile.credentialsArn,
      });

      return {
        stables: ["connectorProfileName", "connectorProfileArn"],

        diff: Effect.fn(function* ({ olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (olds.connectorProfileName !== undefined &&
              olds.connectorProfileName !== news.connectorProfileName) ||
            (olds.connectorType !== undefined &&
              olds.connectorType !== news.connectorType)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const name =
            output?.connectorProfileName ?? olds?.connectorProfileName;
          if (name === undefined) return undefined;
          const profile = yield* observe(name);
          if (
            profile === undefined ||
            profile.connectorProfileArn === undefined
          )
            return undefined;
          return toAttrs(name, profile);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const name = news.connectorProfileName;
          const connectionMode = news.connectionMode ?? "Public";

          // 1. Observe.
          let live = yield* observe(name);

          // 2/3. Ensure + sync — create if missing, else push the new config
          // (credentials cannot be read back, so an update is always sent).
          if (live === undefined) {
            yield* appflow.createConnectorProfile({
              connectorProfileName: name,
              connectorType: news.connectorType,
              connectorLabel: news.connectorLabel,
              connectionMode,
              kmsArn: news.kmsArn,
              connectorProfileConfig: news.connectorProfileConfig,
            });
          } else {
            yield* appflow.updateConnectorProfile({
              connectorProfileName: name,
              connectionMode,
              connectorProfileConfig: news.connectorProfileConfig,
            });
          }
          live = yield* observe(name);
          if (live === undefined || live.connectorProfileArn === undefined) {
            return yield* Effect.fail(
              new Error(
                `Connector profile '${name}' was not found after reconcile`,
              ),
            );
          }

          yield* session.note(name);
          return toAttrs(name, live);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appflow
            .deleteConnectorProfile({
              connectorProfileName: output.connectorProfileName,
              forceDelete: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // maxResults is load-bearing: a fully-empty request body serializes
        // to null and AppFlow rejects it ("The request object must be
        // non-null", verified live).
        list: () =>
          appflow.describeConnectorProfiles.pages({ maxResults: 100 }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.connectorProfileDetails ?? [])
                  .filter(
                    (
                      p,
                    ): p is appflow.ConnectorProfile & {
                      connectorProfileName: string;
                      connectorProfileArn: string;
                    } =>
                      p.connectorProfileName !== undefined &&
                      p.connectorProfileArn !== undefined,
                  )
                  .map((p) => toAttrs(p.connectorProfileName, p)),
              ),
            ),
          ),
      };
    }),
  );
