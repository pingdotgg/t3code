import * as emr from "@distilled.cloud/aws/emr";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface SecurityConfigurationProps {
  /**
   * Name of the security configuration. If omitted, a deterministic physical
   * name is generated. Changing the name replaces the configuration.
   */
  securityConfigurationName?: string;
  /**
   * The security configuration document — encryption, authentication
   * (Kerberos), authorization, and instance-metadata settings — as a plain
   * object or a pre-serialized JSON string. The document is immutable in
   * EMR; content changes are converged by deleting and recreating the
   * configuration under the same name (clusters capture the document at
   * launch, so running clusters are unaffected).
   */
  securityConfiguration: Record<string, unknown> | string;
}

export interface SecurityConfiguration extends Resource<
  "AWS.EMR.SecurityConfiguration",
  SecurityConfigurationProps,
  {
    /** The name of the security configuration. */
    securityConfigurationName: string;
    /** The JSON document of the security configuration. */
    securityConfiguration: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon EMR security configuration — a reusable JSON document of
 * encryption, authentication, and instance-metadata settings referenced by
 * name when launching a {@link Cluster}.
 *
 * Clusters capture the configuration at launch, so editing a configuration
 * only affects clusters launched afterwards.
 * @resource
 * @section Creating a Security Configuration
 * @example Require IMDSv2 on Cluster Instances
 * ```typescript
 * const config = yield* SecurityConfiguration("Imds", {
 *   securityConfiguration: {
 *     InstanceMetadataServiceConfiguration: {
 *       MinimumInstanceMetadataServiceVersion: 2,
 *       HttpPutResponseHopLimit: 1,
 *     },
 *   },
 * });
 * ```
 *
 * @example Encryption Settings
 * ```typescript
 * const config = yield* SecurityConfiguration("Encryption", {
 *   securityConfiguration: {
 *     EncryptionConfiguration: {
 *       EnableInTransitEncryption: false,
 *       EnableAtRestEncryption: true,
 *       AtRestEncryptionConfiguration: {
 *         S3EncryptionConfiguration: { EncryptionMode: "SSE-S3" },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @section Using with a Cluster
 * @example Reference by Name at Launch
 * ```typescript
 * const cluster = yield* Cluster("Secure", {
 *   releaseLabel: "emr-7.5.0",
 *   serviceRole: serviceRole.roleName,
 *   jobFlowRole: instanceProfile.instanceProfileName,
 *   securityConfiguration: config.securityConfigurationName,
 * });
 * ```
 */
export const SecurityConfiguration = Resource<SecurityConfiguration>(
  "AWS.EMR.SecurityConfiguration",
);

/** Serialize the user-facing document prop to the wire JSON string. */
const toDocument = (doc: Record<string, unknown> | string): string =>
  typeof doc === "string" ? doc : JSON.stringify(doc);

/** Key-order-insensitive canonical form for content comparison. */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const canonicalDocument = (doc: string): string => {
  try {
    return stableStringify(JSON.parse(doc));
  } catch {
    return doc;
  }
};

export const SecurityConfigurationProvider = () =>
  Provider.effect(
    SecurityConfiguration,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: Partial<SecurityConfigurationProps>,
      ) =>
        props.securityConfigurationName
          ? Effect.succeed(props.securityConfigurationName)
          : createPhysicalName({ id, maxLength: 64 });

      const readConfiguration = Effect.fn(function* (name: string) {
        return yield* emr
          .describeSecurityConfiguration({ Name: name })
          .pipe(
            Effect.catchTag("SecurityConfigurationNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttrs = (name: string, document: string) => ({
        securityConfigurationName: name,
        securityConfiguration: document,
      });

      return {
        stables: ["securityConfigurationName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news;
          const o = olds;
          if (n === undefined || o === undefined) return undefined;
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          // Content changes converge in place (reconcile deletes and
          // recreates the immutable document under the same name).
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.securityConfigurationName ??
            (yield* toName(id, olds ?? {}));
          const found = yield* readConfiguration(name);
          if (found === undefined) return undefined;
          // Security configurations don't support tags, so an existing
          // document under our derived name is treated as ours.
          return toAttrs(name, found.SecurityConfiguration ?? "");
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name =
            output?.securityConfigurationName ?? (yield* toName(id, props));
          const desired = toDocument(props.securityConfiguration);

          // 1. Observe — cloud state is authoritative.
          const observed = yield* readConfiguration(name);

          // 2/3. Ensure + sync: the document is immutable, so a content
          //      change is converged by deleting the old document and
          //      recreating it under the same name. A concurrent create of
          //      identical content surfaces as AlreadyExists — that's a
          //      race, not a failure.
          if (
            observed?.SecurityConfiguration !== undefined &&
            canonicalDocument(observed.SecurityConfiguration) !==
              canonicalDocument(desired)
          ) {
            yield* emr
              .deleteSecurityConfiguration({ Name: name })
              .pipe(
                Effect.catchTag(
                  "SecurityConfigurationNotFound",
                  () => Effect.void,
                ),
              );
          }
          if (
            observed?.SecurityConfiguration === undefined ||
            canonicalDocument(observed.SecurityConfiguration) !==
              canonicalDocument(desired)
          ) {
            yield* emr
              .createSecurityConfiguration({
                Name: name,
                SecurityConfiguration: desired,
              })
              .pipe(
                Effect.catchTag(
                  "SecurityConfigurationAlreadyExists",
                  () => Effect.void,
                ),
              );
          }

          // 4. Return fresh attributes.
          const final = yield* readConfiguration(name);
          yield* session.note(name);
          return toAttrs(name, final?.SecurityConfiguration ?? desired);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* emr
            .deleteSecurityConfiguration({
              Name: output.securityConfigurationName,
            })
            .pipe(
              Effect.catchTag(
                "SecurityConfigurationNotFound",
                () => Effect.void,
              ),
            );
        }),

        list: () =>
          emr.listSecurityConfigurations.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((summary) =>
                summary.Name ? [summary.Name] : [],
              ),
            ),
            Effect.flatMap(
              Effect.forEach(
                (name) =>
                  readConfiguration(name).pipe(
                    Effect.map((found) =>
                      found === undefined
                        ? []
                        : [toAttrs(name, found.SecurityConfiguration ?? "")],
                    ),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((results) => results.flat()),
          ),
      };
    }),
  );
