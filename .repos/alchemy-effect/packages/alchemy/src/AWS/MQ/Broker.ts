import * as mq from "@distilled.cloud/aws/mq";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { syncMqTags, toTagRecord } from "./internal.ts";

/**
 * An ActiveMQ or RabbitMQ user provisioned on the broker at creation.
 */
export interface BrokerUser {
  /**
   * Username (2-100 chars, `a-z A-Z 0-9 _ ~ . -`). Must not contain commas,
   * colons, equals signs, or the string `tag:`.
   */
  username: string;
  /**
   * Password (12-250 printable chars, no commas, colons, or equals signs).
   */
  password: Redacted.Redacted<string>;
  /**
   * Whether the user can access the ActiveMQ Web Console. Ignored for
   * RabbitMQ.
   * @default false
   */
  consoleAccess?: boolean;
  /**
   * ActiveMQ groups the user belongs to. Ignored for RabbitMQ.
   */
  groups?: string[];
}

/**
 * Reference to a specific {@link Configuration} revision to apply to the
 * broker.
 */
export interface BrokerConfigurationRef {
  /** The configuration id (`configurationId` attribute of a Configuration). */
  id: string;
  /** The revision number to apply. */
  revision?: number;
}

/**
 * CloudWatch log exports to enable for the broker.
 */
export interface BrokerLogs {
  /** Enable audit logging (ActiveMQ only). */
  audit?: boolean;
  /** Enable general logging. */
  general?: boolean;
}

/**
 * Weekly maintenance window during which the broker applies pending changes.
 */
export interface BrokerMaintenanceWindow {
  /** Day of week, e.g. `"SUNDAY"`. */
  dayOfWeek:
    | "MONDAY"
    | "TUESDAY"
    | "WEDNESDAY"
    | "THURSDAY"
    | "FRIDAY"
    | "SATURDAY"
    | "SUNDAY";
  /** Start time in 24h `HH:mm` format, e.g. `"03:00"`. */
  timeOfDay: string;
  /** IANA time zone, e.g. `"UTC"`. */
  timeZone?: string;
}

/**
 * At-rest encryption options for the broker.
 */
export interface BrokerEncryptionOptions {
  /** Customer-managed KMS key id/ARN. Omit to use an AWS-owned key. */
  kmsKeyId?: string;
  /** Use an AWS-owned key rather than a customer-managed one. */
  useAwsOwnedKey?: boolean;
}

export interface BrokerProps {
  /**
   * Name of the broker (1-50 chars, `a-z A-Z 0-9 _ ~ -`). If omitted a
   * deterministic physical name is generated. Immutable — changing it
   * replaces the broker.
   */
  brokerName?: string;
  /**
   * Broker engine. Immutable — changing it replaces the broker.
   */
  engineType: "ACTIVEMQ" | "RABBITMQ";
  /**
   * Broker engine version (e.g. `"5.18"` for ActiveMQ, `"3.13"` for
   * RabbitMQ). Mutable — a change is applied as a pending broker update.
   */
  engineVersion?: string;
  /**
   * Broker instance type, e.g. `"mq.t3.micro"` (the cheapest) or
   * `"mq.m5.large"`. Mutable — a change is applied as a pending broker
   * update.
   */
  hostInstanceType: string;
  /**
   * Deployment topology. `SINGLE_INSTANCE` is a single broker (cheapest,
   * no HA); `ACTIVE_STANDBY_MULTI_AZ` (ActiveMQ) and `CLUSTER_MULTI_AZ`
   * (RabbitMQ) provide HA. Immutable — changing it replaces the broker.
   * @default "SINGLE_INSTANCE"
   */
  deploymentMode?:
    | "SINGLE_INSTANCE"
    | "ACTIVE_STANDBY_MULTI_AZ"
    | "CLUSTER_MULTI_AZ";
  /**
   * Broker users. ActiveMQ requires at least one; RabbitMQ requires exactly
   * one. Users are provisioned at creation and are not reconciled on update.
   */
  users: BrokerUser[];
  /**
   * Whether the broker is reachable over the public internet. Immutable —
   * changing it replaces the broker.
   * @default false
   */
  publiclyAccessible?: boolean;
  /**
   * Subnet ids to deploy the broker into. `SINGLE_INSTANCE` needs one
   * subnet; multi-AZ needs two (ActiveMQ) or three (RabbitMQ cluster). If
   * omitted, a default-VPC subnet is chosen. Immutable — changing it
   * replaces the broker.
   */
  subnetIds?: string[];
  /**
   * Security group ids controlling access to the broker. Mutable — a change
   * is applied as a pending broker update.
   */
  securityGroups?: string[];
  /**
   * Authentication strategy. Mutable — a change is applied as a pending
   * broker update.
   * @default "SIMPLE"
   */
  authenticationStrategy?: "SIMPLE" | "LDAP";
  /**
   * Whether to automatically apply minor engine version upgrades during the
   * maintenance window. RabbitMQ and newer ActiveMQ versions require `true`.
   * Mutable.
   * @default true
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Storage type. `EBS` (durable, default) or `EFS` (ActiveMQ multi-AZ
   * only). Immutable — changing it replaces the broker.
   */
  storageType?: "EBS" | "EFS";
  /**
   * A {@link Configuration} revision to apply. Mutable — a change is applied
   * as a pending broker update.
   */
  configuration?: BrokerConfigurationRef;
  /**
   * CloudWatch log exports. Mutable.
   */
  logs?: BrokerLogs;
  /**
   * Weekly maintenance window. Mutable.
   */
  maintenanceWindow?: BrokerMaintenanceWindow;
  /**
   * At-rest encryption options. Immutable — changing it replaces the broker.
   */
  encryptionOptions?: BrokerEncryptionOptions;
  /**
   * User-defined tags for the broker.
   */
  tags?: Record<string, string>;
}

export interface Broker extends Resource<
  "AWS.MQ.Broker",
  BrokerProps,
  {
    /** Server-assigned unique id of the broker (e.g. `b-1234...`). */
    brokerId: string;
    /** ARN of the broker. */
    brokerArn: string;
    /** Name of the broker. */
    brokerName: string;
    /** Current lifecycle state (e.g. `CREATION_IN_PROGRESS`, `RUNNING`). */
    brokerState: string;
    /** Wire-level connection endpoints (protocol URIs) for the broker. */
    endpoints: string[] | undefined;
    /** ActiveMQ Web Console URL (undefined for RabbitMQ). */
    consoleUrl: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon MQ broker — a managed message broker running Apache ActiveMQ or
 * RabbitMQ. Amazon MQ handles provisioning, patching, and (for multi-AZ
 * deployments) failover, exposing standard wire protocols (OpenWire, AMQP,
 * MQTT, STOMP, WSS) so existing clients connect unchanged.
 *
 * Broker creation and deletion are asynchronous and take several minutes;
 * the provider waits (bounded) for the broker to reach `RUNNING` before
 * returning, and waits for it to disappear on delete.
 *
 * @resource
 * @section Creating a Broker
 * @example Single-instance ActiveMQ (cheapest)
 * ```typescript
 * const broker = yield* MQ.Broker("Orders", {
 *   engineType: "ACTIVEMQ",
 *   engineVersion: "5.18",
 *   hostInstanceType: "mq.t3.micro",
 *   deploymentMode: "SINGLE_INSTANCE",
 *   publiclyAccessible: true,
 *   users: [{ username: "admin", password: Redacted.make("SuperSecretPassw0rd") }],
 * });
 * // broker.endpoints -> ["ssl://b-xxxx-1.mq.us-west-2.amazonaws.com:61617", ...]
 * ```
 *
 * @example Single-instance RabbitMQ
 * ```typescript
 * const broker = yield* MQ.Broker("Events", {
 *   engineType: "RABBITMQ",
 *   engineVersion: "3.13",
 *   hostInstanceType: "mq.t3.micro",
 *   publiclyAccessible: true,
 *   users: [{ username: "admin", password: Redacted.make("SuperSecretPassw0rd") }],
 * });
 * ```
 *
 * @section Networking and Encryption
 * @example Private broker in specific subnets with a customer KMS key
 * ```typescript
 * const broker = yield* MQ.Broker("Orders", {
 *   engineType: "ACTIVEMQ",
 *   engineVersion: "5.18",
 *   hostInstanceType: "mq.m5.large",
 *   deploymentMode: "ACTIVE_STANDBY_MULTI_AZ",
 *   publiclyAccessible: false,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroups: [group.groupId],
 *   encryptionOptions: { kmsKeyId: key.keyArn },
 *   users: [{ username: "admin", password: Redacted.make("SuperSecretPassw0rd") }],
 * });
 * ```
 *
 * @section Logging and Maintenance
 * @example Enable CloudWatch logs and pin a maintenance window
 * ```typescript
 * const broker = yield* MQ.Broker("Orders", {
 *   engineType: "ACTIVEMQ",
 *   engineVersion: "5.18",
 *   hostInstanceType: "mq.t3.micro",
 *   users: [{ username: "admin", password: Redacted.make("SuperSecretPassw0rd") }],
 *   logs: { general: true, audit: true },
 *   maintenanceWindow: {
 *     dayOfWeek: "SUNDAY",
 *     timeOfDay: "03:00",
 *     timeZone: "UTC",
 *   },
 * });
 * ```
 *
 * @section Consuming Messages
 * Subscribe a Lambda function to broker queues from the init phase via
 * {@link consumeBrokerMessages}. The event-source mapping, IAM grants, and
 * runtime dispatch are created automatically (provide
 * `Lambda.BrokerEventSource` on the function).
 *
 * @example Process queue messages in a Lambda function
 * ```typescript
 * // init
 * yield* MQ.consumeBrokerMessages(
 *   broker,
 *   {
 *     queues: ["orders"],
 *     credentialsSecretArn: secret.secretArn,
 *   },
 *   (messages) =>
 *     messages.pipe(
 *       Stream.runForEach((message) =>
 *         Effect.log(`received: ${message.data}`),
 *       ),
 *     ),
 * );
 * ```
 */
export const Broker = Resource<Broker>("AWS.MQ.Broker");

class BrokerNotSettled extends Data.TaggedError("BrokerNotSettled")<{
  readonly brokerId: string;
  readonly state: string;
}> {}

const sameArray = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const as = [...(a ?? [])].sort();
  const bs = [...(b ?? [])].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
};

const toWireUsers = (users: BrokerUser[]): mq.User[] =>
  users.map((u) => ({
    Username: u.username,
    // distilled marks Password sensitive — pass the Redacted value through so
    // it stays redacted until wire encoding.
    Password: u.password,
    ConsoleAccess: u.consoleAccess,
    Groups: u.groups,
  }));

export const BrokerProvider = () =>
  Provider.effect(
    Broker,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<BrokerProps>) =>
        props.brokerName
          ? Effect.succeed(props.brokerName)
          : createPhysicalName({ id, maxLength: 50 });

      /** Describe a broker by id; a missing broker reads as absent. */
      const readBroker = Effect.fn(function* (brokerId: string) {
        return yield* mq
          .describeBroker({ BrokerId: brokerId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /** Find a live broker by name (listBrokers has no name filter). */
      const findByName = Effect.fn(function* (name: string) {
        const summary = yield* mq.listBrokers.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.BrokerSummaries ?? [])
              .find((s) => s.BrokerName === name && s.BrokerId),
          ),
        );
        if (!summary?.BrokerId) return undefined;
        return yield* readBroker(summary.BrokerId);
      });

      // Broker creation is asynchronous and typically takes 5-10 minutes;
      // budget ~12 min (72 * 10s). Wait until the broker leaves a transient
      // state (CREATION_IN_PROGRESS / REBOOT_IN_PROGRESS).
      const waitForSettled = Effect.fn(function* (brokerId: string) {
        return yield* readBroker(brokerId).pipe(
          Effect.flatMap((broker) => {
            const state = broker?.BrokerState;
            if (
              state === "CREATION_IN_PROGRESS" ||
              state === "REBOOT_IN_PROGRESS"
            ) {
              return Effect.fail(new BrokerNotSettled({ brokerId, state }));
            }
            return Effect.succeed(broker);
          }),
          Effect.retry({
            while: (e) => e instanceof BrokerNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(72),
            ]),
          }),
        );
      });

      // Deletion is asynchronous too; wait until the broker is gone so
      // networking dependencies (subnets, security groups) can be removed.
      const waitUntilGone = Effect.fn(function* (brokerId: string) {
        yield* readBroker(brokerId).pipe(
          Effect.flatMap((broker) => {
            if (broker === undefined) return Effect.void;
            return Effect.fail(
              new BrokerNotSettled({
                brokerId,
                state: broker.BrokerState ?? "UNKNOWN",
              }),
            );
          }),
          Effect.retry({
            while: (e) => e instanceof BrokerNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(72),
            ]),
          }),
        );
      });

      const toAttrs = (broker: mq.DescribeBrokerResponse) => ({
        brokerId: broker.BrokerId!,
        brokerArn: broker.BrokerArn!,
        brokerName: broker.BrokerName!,
        brokerState: broker.BrokerState!,
        endpoints: broker.BrokerInstances?.[0]?.Endpoints,
        consoleUrl: broker.BrokerInstances?.[0]?.ConsoleURL,
      });

      return {
        stables: ["brokerId", "brokerArn", "brokerName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const replaced =
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}));
          if (replaced) return { action: "replace" } as const;
          // Create-only properties.
          if (
            (news.engineType ?? undefined) !== (olds?.engineType ?? undefined)
          )
            return { action: "replace" } as const;
          if (
            (news.deploymentMode ?? "SINGLE_INSTANCE") !==
            (olds?.deploymentMode ?? "SINGLE_INSTANCE")
          )
            return { action: "replace" } as const;
          if (
            (news.publiclyAccessible ?? false) !==
            (olds?.publiclyAccessible ?? false)
          )
            return { action: "replace" } as const;
          if (
            (news.storageType ?? undefined) !== (olds?.storageType ?? undefined)
          )
            return { action: "replace" } as const;
          if (
            news.subnetIds !== undefined &&
            !sameArray(news.subnetIds, olds?.subnetIds)
          )
            return { action: "replace" } as const;
          if (
            (news.encryptionOptions?.kmsKeyId ?? undefined) !==
              (olds?.encryptionOptions?.kmsKeyId ?? undefined) ||
            (news.encryptionOptions?.useAwsOwnedKey ?? undefined) !==
              (olds?.encryptionOptions?.useAwsOwnedKey ?? undefined)
          )
            return { action: "replace" } as const;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const broker = output?.brokerId
            ? yield* readBroker(output.brokerId)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (broker === undefined) return undefined;
          const attrs = toAttrs(broker);
          const tags = toTagRecord(broker.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.brokerName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = output?.brokerId
            ? yield* readBroker(output.brokerId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(name);
          }

          // 2. Ensure — create if missing. The deterministic CreatorRequestId
          // makes a retried create idempotent. Tolerate a ConflictException
          // race by re-finding the broker by name.
          if (observed === undefined) {
            const created = yield* mq
              .createBroker({
                BrokerName: name,
                EngineType: news.engineType,
                EngineVersion: news.engineVersion,
                HostInstanceType: news.hostInstanceType,
                DeploymentMode: news.deploymentMode ?? "SINGLE_INSTANCE",
                PubliclyAccessible: news.publiclyAccessible ?? false,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade ?? true,
                AuthenticationStrategy: news.authenticationStrategy,
                StorageType: news.storageType,
                SubnetIds: news.subnetIds,
                SecurityGroups: news.securityGroups,
                Users: toWireUsers(news.users),
                Configuration: news.configuration
                  ? {
                      Id: news.configuration.id,
                      Revision: news.configuration.revision,
                    }
                  : undefined,
                Logs: news.logs
                  ? { Audit: news.logs.audit, General: news.logs.general }
                  : undefined,
                MaintenanceWindowStartTime: news.maintenanceWindow
                  ? {
                      DayOfWeek: news.maintenanceWindow.dayOfWeek,
                      TimeOfDay: news.maintenanceWindow.timeOfDay,
                      TimeZone: news.maintenanceWindow.timeZone,
                    }
                  : undefined,
                EncryptionOptions: news.encryptionOptions
                  ? {
                      KmsKeyId: news.encryptionOptions.kmsKeyId,
                      UseAwsOwnedKey: news.encryptionOptions.useAwsOwnedKey,
                    }
                  : undefined,
                CreatorRequestId: name,
                Tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.gen(function* () {
                    const existing = yield* findByName(name);
                    if (existing?.BrokerId) {
                      return { BrokerId: existing.BrokerId };
                    }
                    return yield* Effect.fail(
                      new Error(
                        `MQ broker '${name}' create conflicted but no broker was found`,
                      ),
                    );
                  }),
                ),
              );
            observed = yield* readBroker(created.BrokerId!);
          }

          if (observed?.BrokerId === undefined) {
            return yield* Effect.fail(
              new Error(`MQ broker '${name}' could not be reconciled`),
            );
          }
          const brokerId = observed.BrokerId;

          // Wait (bounded) for the broker to settle before mutating it.
          const settled = yield* waitForSettled(brokerId);
          if (settled === undefined) {
            return yield* Effect.fail(
              new Error(`MQ broker '${name}' disappeared while reconciling`),
            );
          }
          observed = settled;
          if (observed.BrokerState === "CREATION_FAILED") {
            return yield* Effect.fail(
              new Error(
                `MQ broker '${name}' failed to create (state: CREATION_FAILED)`,
              ),
            );
          }

          // 3. Sync mutable settings — compute an updateBroker request with
          // only the drifted fields (each mutation becomes a pending change).
          const update: Omit<mq.UpdateBrokerRequest, "BrokerId"> = {};
          if (
            news.engineVersion !== undefined &&
            news.engineVersion !== observed.EngineVersion &&
            news.engineVersion !== observed.PendingEngineVersion
          ) {
            update.EngineVersion = news.engineVersion;
          }
          if (
            news.hostInstanceType !== observed.HostInstanceType &&
            news.hostInstanceType !== observed.PendingHostInstanceType
          ) {
            update.HostInstanceType = news.hostInstanceType;
          }
          if (
            news.autoMinorVersionUpgrade !== undefined &&
            news.autoMinorVersionUpgrade !== observed.AutoMinorVersionUpgrade
          ) {
            update.AutoMinorVersionUpgrade = news.autoMinorVersionUpgrade;
          }
          if (
            news.securityGroups !== undefined &&
            !sameArray(news.securityGroups, observed.SecurityGroups)
          ) {
            update.SecurityGroups = news.securityGroups;
          }
          if (
            news.logs !== undefined &&
            (news.logs.audit !== observed.Logs?.Audit ||
              news.logs.general !== observed.Logs?.General)
          ) {
            update.Logs = {
              Audit: news.logs.audit,
              General: news.logs.general,
            };
          }
          if (
            news.configuration !== undefined &&
            (news.configuration.id !== observed.Configurations?.Current?.Id ||
              news.configuration.revision !==
                observed.Configurations?.Current?.Revision)
          ) {
            update.Configuration = {
              Id: news.configuration.id,
              Revision: news.configuration.revision,
            };
          }
          if (
            news.maintenanceWindow !== undefined &&
            (news.maintenanceWindow.dayOfWeek !==
              observed.MaintenanceWindowStartTime?.DayOfWeek ||
              news.maintenanceWindow.timeOfDay !==
                observed.MaintenanceWindowStartTime?.TimeOfDay ||
              news.maintenanceWindow.timeZone !==
                observed.MaintenanceWindowStartTime?.TimeZone)
          ) {
            update.MaintenanceWindowStartTime = {
              DayOfWeek: news.maintenanceWindow.dayOfWeek,
              TimeOfDay: news.maintenanceWindow.timeOfDay,
              TimeZone: news.maintenanceWindow.timeZone,
            };
          }
          if (
            news.authenticationStrategy !== undefined &&
            news.authenticationStrategy !== observed.AuthenticationStrategy &&
            news.authenticationStrategy !==
              observed.PendingAuthenticationStrategy
          ) {
            update.AuthenticationStrategy = news.authenticationStrategy;
          }
          if (Object.keys(update).length > 0) {
            yield* mq.updateBroker({ BrokerId: brokerId, ...update });
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncMqTags(
            observed.BrokerArn!,
            toTagRecord(observed.Tags),
            desiredTags,
          );

          // 4. Re-read for fresh attributes (endpoints appear once RUNNING).
          const final = (yield* readBroker(brokerId)) ?? observed;
          yield* session.note(name);
          return toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A broker mid-operation rejects deletion — wait for it to settle.
          yield* waitForSettled(output.brokerId).pipe(
            Effect.catch(() => Effect.void),
          );
          yield* mq
            .deleteBroker({ BrokerId: output.brokerId })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* waitUntilGone(output.brokerId);
        }),

        list: () =>
          mq.listBrokers.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.BrokerSummaries ?? [])
                .flatMap((s) =>
                  s.BrokerId !== undefined &&
                  s.BrokerArn !== undefined &&
                  s.BrokerName !== undefined &&
                  s.BrokerState !== undefined
                    ? [
                        {
                          brokerId: s.BrokerId,
                          brokerArn: s.BrokerArn,
                          brokerName: s.BrokerName,
                          brokerState: s.BrokerState,
                          endpoints: undefined,
                          consoleUrl: undefined,
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
