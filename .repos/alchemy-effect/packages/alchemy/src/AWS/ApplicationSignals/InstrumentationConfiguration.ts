import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface InstrumentationConfigurationProps {
  /**
   * The kind of dynamic instrumentation: `PROBE` or `BREAKPOINT`.
   * Configurations are immutable — changing the type replaces the
   * configuration.
   */
  instrumentationType: appsignals.InstrumentationType;
  /**
   * Name of the Application Signals service the instrumented code belongs
   * to. Changing it replaces the configuration.
   */
  service: string;
  /**
   * The service's environment (e.g. `eks:prod`, `lambda:default`).
   * Changing it replaces the configuration.
   */
  environment: string;
  /**
   * The signal produced by the instrumentation (currently `SNAPSHOT`).
   * Changing it replaces the configuration.
   */
  signalType: appsignals.DynamicInstrumentationSignalType;
  /**
   * The code location to instrument (`Language`, `FilePath`, and — as the
   * language requires — `CodeUnit`, `ClassName`, `MethodName`,
   * `LineNumber`). Changing the location replaces the configuration.
   */
  location: appsignals.CodeLocation;
  /**
   * What the instrumentation captures at the location: arguments, return
   * value, stack trace, locals, and the mandatory `CaptureLimits`.
   * Configurations are immutable — changing this replaces it.
   */
  captureConfiguration: appsignals.CodeCaptureConfiguration;
  /**
   * A human-readable description of the configuration.
   */
  description?: string;
  /**
   * When the configuration expires and stops instrumenting. Accepts a
   * `Date` or an ISO timestamp string.
   */
  expiresAt?: Date | string;
  /**
   * Attribute filter groups — the instrumentation only fires when a
   * request matches all attributes within one of the groups.
   */
  attributeFilters?: { [key: string]: string | undefined }[];
  /**
   * Tags to apply to the configuration. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface InstrumentationConfiguration extends Resource<
  "AWS.ApplicationSignals.InstrumentationConfiguration",
  InstrumentationConfigurationProps,
  {
    /**
     * ARN of the instrumentation configuration.
     */
    arn: string;
    /**
     * Server-computed hash uniquely identifying the instrumented location
     * within the service/environment/type/signal scope.
     */
    locationHash: string;
    /**
     * The instrumentation type (`PROBE` or `BREAKPOINT`).
     */
    instrumentationType: appsignals.InstrumentationType;
    /**
     * The Application Signals service the configuration belongs to.
     */
    service: string;
    /**
     * The service environment the configuration belongs to.
     */
    environment: string;
    /**
     * The signal type produced by the instrumentation.
     */
    signalType: appsignals.DynamicInstrumentationSignalType;
    /**
     * When the configuration was created (ISO timestamp).
     */
    createdAt: string;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Application Signals dynamic instrumentation configuration —
 * instructs instrumented SDK agents to capture a snapshot (arguments,
 * locals, return value, stack trace) at a specific code location of a
 * discovered service, without redeploying the application.
 *
 * Configurations are immutable after creation: every change except tags
 * replaces the configuration. Tags remain mutable through the standard
 * tagging APIs.
 *
 * @resource
 * @section Creating an Instrumentation Configuration
 * @example Snapshot Probe on a Python Method
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const probe = yield* AWS.ApplicationSignals.InstrumentationConfiguration(
 *   "CheckoutProbe",
 *   {
 *     instrumentationType: "PROBE",
 *     service: "checkout-service",
 *     environment: "eks:prod",
 *     signalType: "SNAPSHOT",
 *     location: {
 *       Language: "Python",
 *       CodeUnit: "app.checkout",
 *       MethodName: "process_order",
 *       FilePath: "app/checkout.py",
 *       LineNumber: 42,
 *     },
 *     captureConfiguration: {
 *       CaptureLocals: ["order_id", "total"],
 *       CaptureLimits: { MaxHits: 100 },
 *     },
 *   },
 * );
 * ```
 *
 * @example Expiring Probe with Attribute Filters
 * ```typescript
 * const probe = yield* AWS.ApplicationSignals.InstrumentationConfiguration(
 *   "DebugProbe",
 *   {
 *     instrumentationType: "PROBE",
 *     service: "checkout-service",
 *     environment: "eks:prod",
 *     signalType: "SNAPSHOT",
 *     location: {
 *       Language: "Java",
 *       ClassName: "com.example.Checkout",
 *       MethodName: "processOrder",
 *       FilePath: "src/main/java/com/example/Checkout.java",
 *     },
 *     captureConfiguration: {
 *       CaptureArguments: ["order"],
 *       CaptureLimits: { MaxHits: 10 },
 *     },
 *     expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
 *     attributeFilters: [{ "aws.local.operation": "POST /checkout" }],
 *   },
 * );
 * ```
 */
export const InstrumentationConfiguration =
  Resource<InstrumentationConfiguration>(
    "AWS.ApplicationSignals.InstrumentationConfiguration",
  );

/**
 * Normalize `expiresAt` (which the engine's state serialization flattens to
 * an ISO string) back to a `Date` for the wire.
 */
const toExpiresAt = (value: Date | string | undefined): Date | undefined =>
  value === undefined ? undefined : new Date(value);

/**
 * The identity + payload of a configuration in a canonical, comparable
 * shape. Everything here is create-only: a change replaces the resource.
 */
const immutableFingerprint = (props: InstrumentationConfigurationProps) =>
  JSON.stringify({
    instrumentationType: props.instrumentationType,
    service: props.service,
    environment: props.environment,
    signalType: props.signalType,
    location: props.location,
    captureConfiguration: props.captureConfiguration,
    description: props.description,
    expiresAt: toExpiresAt(props.expiresAt)?.getTime(),
    attributeFilters: props.attributeFilters,
  });

export const InstrumentationConfigurationProvider = () =>
  Provider.effect(
    InstrumentationConfiguration,
    Effect.gen(function* () {
      /** The identity quadruple shared by get/create/delete requests. */
      const identity = (
        props: Pick<
          InstrumentationConfigurationProps,
          "instrumentationType" | "service" | "environment" | "signalType"
        >,
      ) => ({
        InstrumentationType: props.instrumentationType,
        Service: props.service,
        Environment: props.environment,
        SignalType: props.signalType,
      });

      /** Observe by location hash (preferred) or code location. */
      const observe = Effect.fn(function* (
        props: InstrumentationConfigurationProps,
        locationHash: string | undefined,
      ) {
        const response = yield* appsignals
          .getInstrumentationConfiguration({
            ...identity(props),
            LocationIdentifier: locationHash
              ? { LocationHash: locationHash }
              : { CodeLocation: props.location },
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Configuration;
      });

      const observedTags = (arn: string) =>
        appsignals.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map((response) =>
            Object.fromEntries(
              (response.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
            ),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toAttrs = (
        configuration: appsignals.InstrumentationConfiguration,
      ) => ({
        arn: configuration.ARN,
        locationHash: configuration.LocationHash,
        instrumentationType: configuration.InstrumentationType,
        service: configuration.Service,
        environment: configuration.Environment,
        signalType: configuration.SignalType,
        createdAt: configuration.CreatedAt.toISOString(),
      });

      return {
        stables: [
          "arn",
          "locationHash",
          "instrumentationType",
          "service",
          "environment",
          "signalType",
        ],

        read: Effect.fn(function* ({ id, olds, output }) {
          const props = olds;
          if (props === undefined) return undefined;
          const found = yield* observe(props, output?.locationHash);
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* observedTags(found.ARN);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // Configurations are immutable after creation — any change other
          // than tags replaces. Tags fall through to the default update.
          if (
            olds !== undefined &&
            immutableFingerprint(news) !== immutableFingerprint(olds)
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. Observe — cloud state is authoritative; `output` only caches
          //    the location hash.
          let live = yield* observe(news, output?.locationHash);

          if (live === undefined) {
            // 2. Ensure — create when missing; a concurrent create of the
            //    same location surfaces as ConflictException, which is a
            //    race: re-observe and continue.
            live = yield* appsignals
              .createInstrumentationConfiguration({
                ...identity(news),
                Location: { CodeLocation: news.location },
                CaptureConfiguration: {
                  CodeCapture: news.captureConfiguration,
                },
                Description: news.description,
                ExpiresAt: toExpiresAt(news.expiresAt),
                AttributeFilters: news.attributeFilters,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  observe(news, undefined).pipe(
                    Effect.flatMap((observed) =>
                      observed === undefined
                        ? Effect.fail(
                            new Error(
                              `instrumentation configuration for '${news.service}' conflicted but was not observable`,
                            ),
                          )
                        : Effect.succeed(observed),
                    ),
                  ),
                ),
              );
          }
          // 3. There is no update API — the diff replaces on any change to
          //    the immutable payload, so an observed configuration is
          //    already converged apart from tags.

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (create-time Tags only apply on first create).
          const currentTags = yield* observedTags(live.ARN);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* appsignals.tagResource({
              ResourceArn: live.ARN,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* appsignals.untagResource({
              ResourceArn: live.ARN,
              TagKeys: removed,
            });
          }

          yield* session.note(live.LocationHash);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* appsignals
            .deleteInstrumentationConfiguration({
              InstrumentationType: output.instrumentationType,
              Service: output.service,
              Environment: output.environment,
              SignalType: output.signalType,
              LocationIdentifier: { LocationHash: output.locationHash },
            })
            .pipe(
              // Idempotent delete — already-gone is success.
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // No account-wide enumeration API (listing requires a service +
        // environment + type scope).
        list: () => Effect.succeed([]),
      };
    }),
  );
