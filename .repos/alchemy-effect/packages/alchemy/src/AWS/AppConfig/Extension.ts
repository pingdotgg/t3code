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
import type { Providers } from "../Providers.ts";
import { readAppConfigTags, syncAppConfigTags } from "./internal.ts";

/**
 * The workflow points at which AppConfig invokes an extension's actions.
 * `PRE_*` action points run synchronously and can validate or modify the
 * operation; `ON_*` action points are notifications fired as a deployment
 * progresses.
 */
export type ExtensionActionPoint =
  | "PRE_CREATE_HOSTED_CONFIGURATION_VERSION"
  | "PRE_START_DEPLOYMENT"
  | "AT_DEPLOYMENT_TICK"
  | "ON_DEPLOYMENT_START"
  | "ON_DEPLOYMENT_STEP"
  | "ON_DEPLOYMENT_BAKING"
  | "ON_DEPLOYMENT_COMPLETE"
  | "ON_DEPLOYMENT_ROLLED_BACK";

/**
 * A single action AppConfig performs when the owning action point fires.
 */
export interface ExtensionAction {
  /** Name of the action (unique within the extension). */
  name: string;
  /** Description of what the action does. */
  description?: string;
  /**
   * ARN of the integration target: a Lambda function, SNS topic, SQS queue,
   * or EventBridge event bus.
   */
  uri: string;
  /**
   * ARN of an IAM role AppConfig assumes to invoke the target. Required for
   * Lambda, SNS, and SQS targets; not used for EventBridge targets.
   */
  roleArn?: string;
}

/**
 * A parameter the extension accepts. Values are supplied per association via
 * {@link ExtensionAssociationProps.parameters}.
 */
export interface ExtensionParameter {
  /** Description of the parameter. */
  description?: string;
  /** Whether every association must supply a value. */
  required?: boolean;
  /** Whether the value may be supplied at deployment time. */
  dynamic?: boolean;
}

export interface ExtensionProps {
  /**
   * Name of the extension. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the extension.
   */
  extensionName?: string;
  /**
   * Description of the extension.
   */
  description?: string;
  /**
   * The actions to perform, keyed by the action point that triggers them.
   */
  actions: { [P in ExtensionActionPoint]?: ExtensionAction[] };
  /**
   * Parameters accepted by the extension, keyed by parameter name. Values are
   * supplied when the extension is associated with a resource.
   */
  parameters?: Record<string, ExtensionParameter>;
  /**
   * User-defined tags for the extension.
   */
  tags?: Record<string, string>;
}

export interface Extension extends Resource<
  "AWS.AppConfig.Extension",
  ExtensionProps,
  {
    extensionId: string;
    extensionName: string;
    extensionArn: string;
    versionNumber: number;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig extension — a set of actions AppConfig performs at
 * specific points of the configuration workflow (before a version is
 * created, before/while/after a deployment). Actions can invoke Lambda
 * functions, publish to SNS/SQS, or emit EventBridge events.
 *
 * Associate the extension with an application, environment, or configuration
 * profile using {@link ExtensionAssociation}.
 *
 * @resource
 * @section Creating an Extension
 * @example Notify a Lambda when a deployment completes
 * ```typescript
 * const extension = yield* AppConfig.Extension("DeployHook", {
 *   actions: {
 *     ON_DEPLOYMENT_COMPLETE: [
 *       {
 *         name: "notify",
 *         uri: fn.functionArn,
 *         roleArn: role.roleArn,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Validate content before a deployment starts
 * ```typescript
 * const extension = yield* AppConfig.Extension("PreflightCheck", {
 *   description: "Reject deployments outside business hours",
 *   actions: {
 *     PRE_START_DEPLOYMENT: [
 *       { name: "preflight", uri: fn.functionArn, roleArn: role.roleArn },
 *     ],
 *   },
 * });
 * ```
 */
export const Extension = Resource<Extension>("AWS.AppConfig.Extension");

const toWireActions = (
  actions: ExtensionProps["actions"],
): { [key: string]: appconfig.Action[] | undefined } =>
  Object.fromEntries(
    Object.entries(actions).map(([point, list]) => [
      point,
      list?.map((action) => ({
        Name: action.name,
        Description: action.description,
        Uri: action.uri,
        RoleArn: action.roleArn,
      })),
    ]),
  );

const toWireParameters = (
  parameters: ExtensionProps["parameters"],
): { [key: string]: appconfig.Parameter | undefined } | undefined =>
  parameters === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(parameters).map(([name, parameter]) => [
          name,
          {
            Description: parameter.description,
            Required: parameter.required,
            Dynamic: parameter.dynamic,
          },
        ]),
      );

/** Stable JSON for order-insensitive comparison of wire action/param maps. */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, fieldValue]) => fieldValue !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );

export const ExtensionProvider = () =>
  Provider.effect(
    Extension,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ExtensionProps>) =>
        props.extensionName
          ? Effect.succeed(props.extensionName)
          : createPhysicalName({ id, maxLength: 64 });

      const readExtension = Effect.fn(function* (extensionId: string) {
        return yield* appconfig
          .getExtension({ ExtensionIdentifier: extensionId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* appconfig.listExtensions
          .pages({ Name: name })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Items ?? []),
            ),
          );
        // listExtensions returns one summary per version — take the latest.
        const latest = summaries.reduce(
          (
            acc: appconfig.ExtensionSummary | undefined,
            summary: appconfig.ExtensionSummary,
          ) =>
            acc === undefined ||
            (summary.VersionNumber ?? 0) > (acc.VersionNumber ?? 0)
              ? summary
              : acc,
          undefined,
        );
        return latest?.Id === undefined
          ? undefined
          : yield* readExtension(latest.Id);
      });

      const toAttrs = (extension: appconfig.Extension) => ({
        extensionId: extension.Id!,
        extensionName: extension.Name!,
        extensionArn: extension.Arn!,
        versionNumber: extension.VersionNumber ?? 1,
      });

      return {
        stables: ["extensionId", "extensionName", "extensionArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const extension = output?.extensionId
            ? yield* readExtension(output.extensionId)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (extension?.Id === undefined) return undefined;
          const attrs = toAttrs(extension);
          const tags = yield* readAppConfigTags(attrs.extensionArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.extensionName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredActions = toWireActions(news.actions);
          const desiredParameters = toWireParameters(news.parameters);

          // 1. Observe.
          let observed = output?.extensionId
            ? yield* readExtension(output.extensionId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(name);
          }

          // 2. Ensure. A freshly created invoke role may not be assumable
          // yet (IAM propagation), which AppConfig surfaces as
          // BadRequestException — absorb that window with a bounded retry.
          if (observed?.Id === undefined) {
            observed = yield* appconfig
              .createExtension({
                Name: name,
                Description: news.description,
                Actions: desiredActions,
                Parameters: desiredParameters,
                Tags: desiredTags,
              })
              .pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "BadRequestException",
                  schedule: Schedule.fixed("3 seconds"),
                  times: 5,
                }),
              );
          } else if (
            (observed.Description ?? undefined) !==
              (news.description ?? undefined) ||
            stableJson(observed.Actions ?? {}) !== stableJson(desiredActions) ||
            stableJson(observed.Parameters ?? {}) !==
              stableJson(desiredParameters ?? {})
          ) {
            // 3. Sync — description, actions, and parameters are mutable
            // (AppConfig records the change as a new extension version).
            observed = yield* appconfig.updateExtension({
              ExtensionIdentifier: observed.Id,
              Description: news.description,
              Actions: desiredActions,
              Parameters: desiredParameters,
            });
          }

          const attrs = toAttrs(observed);

          // 3b. Sync tags against observed cloud tags.
          yield* syncAppConfigTags(attrs.extensionArn, desiredTags);

          yield* session.note(name);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          // Associations must be gone before the extension can be deleted;
          // the engine deletes them first, but the API is eventually
          // consistent, so absorb the dependency-violation window (surfaced
          // as BadRequestException) with a bounded retry.
          yield* appconfig
            .deleteExtension({ ExtensionIdentifier: output.extensionId })
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
            const summaries = yield* appconfig.listExtensions.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Items ?? []),
              ),
            );
            // One summary per version — keep the latest version per id.
            const latest = new Map<string, appconfig.ExtensionSummary>();
            for (const summary of summaries) {
              if (summary.Id === undefined) continue;
              const existing = latest.get(summary.Id);
              if (
                existing === undefined ||
                (summary.VersionNumber ?? 0) > (existing.VersionNumber ?? 0)
              ) {
                latest.set(summary.Id, summary);
              }
            }
            return Array.from(latest.values()).flatMap((summary) =>
              summary.Id !== undefined &&
              summary.Name !== undefined &&
              summary.Arn !== undefined &&
              // AWS-authored extensions (AWS.AppConfig.FeatureFlags,
              // AWS.AppConfig.DeploymentNotificationsTo*, ...) are managed by
              // AWS and cannot be deleted; their ARNs have an empty account
              // segment (arn:aws:appconfig:{region}::extension/...).
              summary.Arn.split(":")[4] !== ""
                ? [
                    {
                      extensionId: summary.Id,
                      extensionName: summary.Name,
                      extensionArn: summary.Arn,
                      versionNumber: summary.VersionNumber ?? 1,
                    },
                  ]
                : [],
            );
          }),
      };
    }),
  );
