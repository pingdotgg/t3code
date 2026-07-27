import * as mq from "@distilled.cloud/aws/mq";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { syncMqTags, toTagRecord } from "./internal.ts";

export interface ConfigurationProps {
  /**
   * Name of the configuration (1-150 chars, `a-z A-Z 0-9 . _ ~ -`). If
   * omitted a deterministic physical name is generated. The name is
   * immutable — changing it replaces the configuration.
   */
  configurationName?: string;
  /**
   * Broker engine the configuration targets. Immutable — changing it
   * replaces the configuration.
   */
  engineType: "ACTIVEMQ" | "RABBITMQ";
  /**
   * Broker engine version the configuration targets (e.g. `"5.18"` for
   * ActiveMQ, `"3.13"` for RabbitMQ). Immutable — changing it replaces the
   * configuration.
   */
  engineVersion?: string;
  /**
   * Authentication strategy for the associated broker. Immutable —
   * changing it replaces the configuration.
   * @default "SIMPLE"
   */
  authenticationStrategy?: "SIMPLE" | "LDAP";
  /**
   * The broker configuration document as plain text (ActiveMQ XML or
   * RabbitMQ Cuttlefish). Alchemy base64-encodes it for the API. Supplying
   * (or changing) `data` publishes a new configuration revision. Omitting
   * it keeps the engine's default revision.
   */
  data?: string;
  /**
   * Description recorded on the published revision. Only applied when `data`
   * is also supplied (the API updates data + description together).
   */
  description?: string;
  /**
   * User-defined tags for the configuration.
   */
  tags?: Record<string, string>;
}

export interface Configuration extends Resource<
  "AWS.MQ.Configuration",
  ConfigurationProps,
  {
    /** Server-assigned unique id of the configuration (e.g. `c-1234...`). */
    configurationId: string;
    /** ARN of the configuration. */
    configurationArn: string;
    /** Name of the configuration. */
    configurationName: string;
    /** Latest published revision number. */
    configurationRevision: number;
    /** Broker engine the configuration targets (`ACTIVEMQ` or `RABBITMQ`). */
    engineType: string;
    /** Engine version the configuration targets. */
    engineVersion: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon MQ broker configuration — a versioned document (ActiveMQ XML or
 * RabbitMQ Cuttlefish) that a {@link Broker} can reference to control
 * engine-level settings. Each edit to `data` publishes a new immutable
 * revision; a broker pins a specific `{ id, revision }` pair.
 *
 * @resource
 * @section Creating a Configuration
 * @example Default ActiveMQ Configuration
 * ```typescript
 * const config = yield* MQ.Configuration("BrokerConfig", {
 *   engineType: "ACTIVEMQ",
 *   engineVersion: "5.18",
 * });
 * ```
 *
 * @example Custom ActiveMQ Configuration Document
 * ```typescript
 * const config = yield* MQ.Configuration("BrokerConfig", {
 *   engineType: "ACTIVEMQ",
 *   engineVersion: "5.18",
 *   description: "Enable statistics plugin",
 *   data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
 * <broker xmlns="http://activemq.apache.org/schema/core">
 *   <plugins>
 *     <statisticsBrokerPlugin/>
 *   </plugins>
 * </broker>`,
 * });
 * // config.configurationRevision -> 2 (the published revision)
 * ```
 *
 * @section Attaching to a Broker
 * @example Reference a Configuration from a Broker
 * ```typescript
 * const broker = yield* MQ.Broker("Orders", {
 *   engineType: "ACTIVEMQ",
 *   engineVersion: "5.18",
 *   hostInstanceType: "mq.t3.micro",
 *   users: [{ username: "admin", password: Redacted.make("SuperSecretPassw0rd") }],
 *   configuration: {
 *     id: config.configurationId,
 *     revision: config.configurationRevision,
 *   },
 * });
 * ```
 */
export const Configuration = Resource<Configuration>("AWS.MQ.Configuration");

const encodeData = (data: string): Effect.Effect<string> =>
  Effect.sync(() => Buffer.from(data, "utf8").toString("base64"));

const decodeData = (data: string | undefined): Effect.Effect<string> =>
  Effect.sync(() =>
    data === undefined ? "" : Buffer.from(data, "base64").toString("utf8"),
  );

export const ConfigurationProvider = () =>
  Provider.effect(
    Configuration,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ConfigurationProps>) =>
        props.configurationName
          ? Effect.succeed(props.configurationName)
          : createPhysicalName({ id, maxLength: 150 });

      /** Read a configuration by id; a missing configuration reads as absent. */
      const readConfiguration = Effect.fn(function* (configurationId: string) {
        return yield* mq
          .describeConfiguration({ ConfigurationId: configurationId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /** Enumerate all configurations (listConfigurations is not paginated). */
      const listAllConfigurations = Effect.fn(function* () {
        const configs: mq.Configuration[] = [];
        let nextToken: string | undefined;
        // Bounded page walk — MQ terminates on an absent NextToken.
        for (let page = 0; page < 20; page++) {
          const response = yield* mq.listConfigurations({
            MaxResults: 100,
            NextToken: nextToken,
          });
          configs.push(...(response.Configurations ?? []));
          nextToken = response.NextToken;
          if (!nextToken) break;
        }
        return configs;
      });

      /** Find a live configuration by name. */
      const findByName = Effect.fn(function* (name: string) {
        const configs = yield* listAllConfigurations();
        const summary = configs.find((c) => c.Name === name && c.Id);
        if (!summary?.Id) return undefined;
        return yield* readConfiguration(summary.Id);
      });

      const toAttrs = (config: mq.DescribeConfigurationResponse) => ({
        configurationId: config.Id!,
        configurationArn: config.Arn!,
        configurationName: config.Name!,
        configurationRevision: config.LatestRevision?.Revision ?? 1,
        engineType: config.EngineType!,
        engineVersion: config.EngineVersion,
      });

      return {
        stables: ["configurationId", "configurationArn", "configurationName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // Engine type, version, and auth strategy are fixed at creation.
          if (
            (news.engineType ?? undefined) !== (olds?.engineType ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (news.engineVersion ?? undefined) !==
            (olds?.engineVersion ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (news.authenticationStrategy ?? undefined) !==
            (olds?.authenticationStrategy ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const config = output?.configurationId
            ? yield* readConfiguration(output.configurationId)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (config === undefined) return undefined;
          const attrs = toAttrs(config);
          const tags = toTagRecord(config.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.configurationName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = output?.configurationId
            ? yield* readConfiguration(output.configurationId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(name);
          }

          // 2. Ensure — create if missing. createConfiguration seeds an
          // initial default revision; `data` (if any) is published below.
          if (observed === undefined) {
            const created = yield* mq.createConfiguration({
              Name: name,
              EngineType: news.engineType,
              EngineVersion: news.engineVersion,
              AuthenticationStrategy: news.authenticationStrategy,
              Tags: desiredTags,
            });
            observed = yield* readConfiguration(created.Id!);
            if (observed === undefined) {
              return yield* Effect.fail(
                new Error(
                  `MQ configuration '${name}' disappeared immediately after create`,
                ),
              );
            }
          }

          const configurationId = observed.Id!;

          // 3. Sync configuration document — publish a new revision only when
          // the desired `data` differs from the current latest revision.
          if (news.data !== undefined) {
            const revision = observed.LatestRevision?.Revision;
            const current =
              revision === undefined
                ? undefined
                : yield* mq.describeConfigurationRevision({
                    ConfigurationId: configurationId,
                    ConfigurationRevision: String(revision),
                  });
            const currentData = yield* decodeData(current?.Data);
            if (currentData !== news.data) {
              yield* mq.updateConfiguration({
                ConfigurationId: configurationId,
                Data: yield* encodeData(news.data),
                Description: news.description,
              });
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMqTags(
            observed.Arn!,
            toTagRecord(observed.Tags),
            desiredTags,
          );

          // 4. Re-read for the fresh latest revision + tags.
          const final = yield* readConfiguration(configurationId);
          if (final === undefined) {
            return yield* Effect.fail(
              new Error(
                `MQ configuration '${name}' disappeared while reconciling`,
              ),
            );
          }
          yield* session.note(name);
          return toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* mq
            .deleteConfiguration({ ConfigurationId: output.configurationId })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),

        list: () =>
          Effect.gen(function* () {
            const configs = yield* listAllConfigurations();
            return configs.flatMap((c) =>
              c.Id !== undefined && c.Arn !== undefined && c.Name !== undefined
                ? [
                    {
                      configurationId: c.Id,
                      configurationArn: c.Arn,
                      configurationName: c.Name,
                      configurationRevision: c.LatestRevision?.Revision ?? 1,
                      engineType: c.EngineType!,
                      engineVersion: c.EngineVersion,
                    },
                  ]
                : [],
            );
          }),
      };
    }),
  );
