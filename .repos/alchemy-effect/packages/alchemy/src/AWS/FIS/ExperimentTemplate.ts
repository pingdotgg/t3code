import * as fis from "@distilled.cloud/aws/fis";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as crypto from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { toSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * A filter that narrows the resources selected by an experiment template
 * target using resource attribute paths.
 */
export interface ExperimentTemplateTargetFilter {
  /**
   * The attribute path used to filter, e.g. `State.Name` for EC2 instances.
   */
  path: string;
  /**
   * The attribute values that a resource must match to be included.
   */
  values: string[];
}

/**
 * A target definition for an experiment template — the set of resources an
 * action is applied to.
 */
export interface ExperimentTemplateTarget {
  /**
   * The resource type of the target, e.g. `aws:ec2:instance`.
   */
  resourceType: string;
  /**
   * ARNs of specific resources to target. Mutually exclusive with
   * `resourceTags`.
   */
  resourceArns?: string[];
  /**
   * Tags that resources must have to be targeted. Mutually exclusive with
   * `resourceArns`.
   */
  resourceTags?: Record<string, string>;
  /**
   * Filters that further narrow the targeted resources by attribute path,
   * e.g. only running instances.
   */
  filters?: ExperimentTemplateTargetFilter[];
  /**
   * How targets are selected from the matched resources, e.g. `ALL`,
   * `COUNT(1)`, or `PERCENT(25)`.
   */
  selectionMode: string;
  /**
   * Resource-type-specific parameters for the target.
   */
  parameters?: Record<string, string>;
}

/**
 * An action carried out on targets during an experiment, e.g.
 * `aws:ec2:stop-instances`.
 */
export interface ExperimentTemplateAction {
  /**
   * The FIS action ID, e.g. `aws:ec2:stop-instances` or
   * `aws:fis:wait`.
   */
  actionId: string;
  /**
   * A description of the action.
   */
  description?: string;
  /**
   * Action-specific parameters, e.g.
   * `{ startInstancesAfterDuration: "PT2M" }`.
   */
  parameters?: Record<string, string>;
  /**
   * The named targets (keys of the template's `targets` map) the action
   * applies to, keyed by the action's target name, e.g.
   * `{ Instances: "MyTarget" }`.
   */
  targets?: Record<string, string>;
  /**
   * Names of other actions that must complete before this action starts.
   */
  startAfter?: string[];
}

/**
 * A stop condition for an experiment. When triggered while an experiment is
 * running, the experiment is stopped.
 */
export interface ExperimentTemplateStopCondition {
  /**
   * The source of the stop condition: `aws:cloudwatch:alarm` or `none`.
   */
  source: "aws:cloudwatch:alarm" | "none" | (string & {});
  /**
   * The ARN of the CloudWatch alarm. Required when `source` is
   * `aws:cloudwatch:alarm`.
   */
  value?: string;
}

/**
 * Experiment log delivery configuration.
 */
export interface ExperimentTemplateLogConfiguration {
  /**
   * Deliver experiment logs to a CloudWatch Logs log group.
   */
  cloudWatchLogsConfiguration?: {
    /**
     * The ARN of the destination log group.
     */
    logGroupArn: string;
  };
  /**
   * Deliver experiment logs to an S3 bucket.
   */
  s3Configuration?: {
    /**
     * The name of the destination bucket.
     */
    bucketName: string;
    /**
     * The bucket prefix for delivered log objects.
     */
    prefix?: string;
  };
  /**
   * The schema version of delivered log records.
   * @default 2
   */
  logSchemaVersion?: number;
}

/**
 * Experiment options controlling account targeting and empty-target
 * behavior.
 */
export interface ExperimentTemplateExperimentOptions {
  /**
   * Whether the experiment targets resources in the current account only or
   * across multiple accounts. Changing this replaces the template.
   * @default "single-account"
   */
  accountTargeting?: "single-account" | "multi-account";
  /**
   * What happens when a target resolves to zero resources: `fail` the
   * experiment or `skip` the action.
   * @default "fail"
   */
  emptyTargetResolutionMode?: "fail" | "skip";
}

/**
 * Experiment report configuration.
 */
export interface ExperimentTemplateReportConfiguration {
  /**
   * Where the experiment report is delivered.
   */
  outputs?: {
    /**
     * Deliver the report to an S3 bucket.
     */
    s3Configuration?: {
      /**
       * The name of the destination bucket.
       */
      bucketName?: string;
      /**
       * The bucket prefix for the delivered report.
       */
      prefix?: string;
    };
  };
  /**
   * Data sources included in the report.
   */
  dataSources?: {
    /**
     * CloudWatch dashboards to capture in the report.
     */
    cloudWatchDashboards?: {
      /**
       * The ARN of the CloudWatch dashboard.
       */
      dashboardIdentifier?: string;
    }[];
  };
  /**
   * How long before the experiment to capture data, e.g. `"10 minutes"` or
   * `Duration.minutes(10)`. Sent to FIS as an ISO-8601 duration (`PT10M`).
   */
  preExperimentDuration?: Duration.Input;
  /**
   * How long after the experiment to capture data, e.g. `"10 minutes"` or
   * `Duration.minutes(10)`. Sent to FIS as an ISO-8601 duration (`PT10M`).
   */
  postExperimentDuration?: Duration.Input;
}

export interface ExperimentTemplateProps {
  /**
   * A description of the experiment template.
   * @default the logical ID of the resource
   */
  description?: string;
  /**
   * The ARN of the IAM role that grants FIS permission to perform the
   * template's actions on your behalf. The role must trust
   * `fis.amazonaws.com`.
   */
  roleArn: string;
  /**
   * The actions carried out during an experiment, keyed by a name of your
   * choosing.
   */
  actions: Record<string, ExperimentTemplateAction>;
  /**
   * The targets the actions apply to, keyed by a name of your choosing and
   * referenced from each action's `targets` map.
   */
  targets?: Record<string, ExperimentTemplateTarget>;
  /**
   * Stop conditions that halt a running experiment when triggered.
   * @default [{ source: "none" }]
   */
  stopConditions?: ExperimentTemplateStopCondition[];
  /**
   * Experiment log delivery configuration. Once configured, log delivery
   * cannot be fully removed via the API — only changed.
   */
  logConfiguration?: ExperimentTemplateLogConfiguration;
  /**
   * Experiment options. `accountTargeting` is create-only — changing it
   * replaces the template.
   */
  experimentOptions?: ExperimentTemplateExperimentOptions;
  /**
   * Experiment report configuration.
   */
  experimentReportConfiguration?: ExperimentTemplateReportConfiguration;
  /**
   * Tags to apply to the experiment template. Merged with internal Alchemy
   * tags.
   */
  tags?: Record<string, string>;
}

export interface ExperimentTemplate extends Resource<
  "AWS.FIS.ExperimentTemplate",
  ExperimentTemplateProps,
  {
    /**
     * The generated ID of the experiment template, e.g. `EXT1a2b3c4d`.
     */
    id: string;
    /**
     * The ARN of the experiment template.
     */
    arn: string;
    /**
     * The ARN of the IAM role the experiment runs as.
     */
    roleArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Fault Injection Service (FIS) experiment template — a reusable
 * definition of a chaos-engineering experiment: the targets to disrupt, the
 * fault actions to run against them, and the stop conditions that abort a
 * runaway experiment.
 *
 * Creating a template is free and does not disrupt any resources — faults
 * are only injected when an experiment is explicitly started from the
 * template.
 * @resource
 * @section Creating Experiment Templates
 * @example Stop EC2 instances selected by tag
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const role = yield* AWS.IAM.Role("FisRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "fis.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 *   managedPolicyArns: [
 *     "arn:aws:iam::aws:policy/service-role/AWSFaultInjectionSimulatorEC2Access",
 *   ],
 * });
 *
 * const template = yield* AWS.FIS.ExperimentTemplate("StopInstances", {
 *   description: "Stop one tagged instance for two minutes",
 *   roleArn: role.roleArn,
 *   targets: {
 *     Instances: {
 *       resourceType: "aws:ec2:instance",
 *       resourceTags: { ChaosReady: "true" },
 *       selectionMode: "COUNT(1)",
 *     },
 *   },
 *   actions: {
 *     StopInstances: {
 *       actionId: "aws:ec2:stop-instances",
 *       parameters: { startInstancesAfterDuration: "PT2M" },
 *       targets: { Instances: "Instances" },
 *     },
 *   },
 * });
 * ```
 *
 * @example Stop condition backed by a CloudWatch alarm
 * ```typescript
 * const template = yield* AWS.FIS.ExperimentTemplate("GuardedExperiment", {
 *   roleArn: role.roleArn,
 *   targets: {
 *     Instances: {
 *       resourceType: "aws:ec2:instance",
 *       resourceTags: { ChaosReady: "true" },
 *       selectionMode: "ALL",
 *     },
 *   },
 *   actions: {
 *     StopInstances: {
 *       actionId: "aws:ec2:stop-instances",
 *       targets: { Instances: "Instances" },
 *     },
 *   },
 *   stopConditions: [
 *     {
 *       source: "aws:cloudwatch:alarm",
 *       value: alarmArn,
 *     },
 *   ],
 * });
 * ```
 *
 * @example Wait action sequenced after a fault
 * ```typescript
 * const template = yield* AWS.FIS.ExperimentTemplate("SequencedExperiment", {
 *   roleArn: role.roleArn,
 *   actions: {
 *     Wait: {
 *       actionId: "aws:fis:wait",
 *       parameters: { duration: "PT1M" },
 *     },
 *     WaitAgain: {
 *       actionId: "aws:fis:wait",
 *       parameters: { duration: "PT1M" },
 *       startAfter: ["Wait"],
 *     },
 *   },
 * });
 * ```
 */
export const ExperimentTemplate = Resource<ExperimentTemplate>(
  "AWS.FIS.ExperimentTemplate",
);

/**
 * A freshly created IAM role referenced by `roleArn` can take a few seconds
 * to become visible to FIS, which rejects the create/update with a
 * `ValidationException` until the role propagates. Bounded retry through the
 * propagation window. Explicitly typed so the conditional `Retry.Return`
 * type never leaks into declaration emit.
 */
const retryRolePropagation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ValidationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

/**
 * Deterministic stringification for observed-vs-desired comparison: sorts
 * object keys and drops `undefined` members, empty arrays, and empty objects
 * so wire-level "absent" and "empty" compare equal.
 */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(normalize).filter((v) => v !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, normalize(v)] as const)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value;
};

const stableStringify = (value: unknown): string =>
  JSON.stringify(normalize(value) ?? null);

export const ExperimentTemplateProvider = () =>
  Provider.effect(
    ExperimentTemplate,
    Effect.gen(function* () {
      const getTemplate = (templateId: string) =>
        fis.getExperimentTemplate({ id: templateId }).pipe(
          Effect.map((r) => r.experimentTemplate),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      // FIS template IDs are server-generated, so when the cached output is
      // lost (state persistence failure) we recover our template by the
      // internal Alchemy tags carried on the list summaries. The match is
      // scoped to the INSTANCE id (not just stack/stage/logical id): during a
      // replacement the new instance must not "recover" the old physical
      // template — it has to create a fresh one.
      const findByTags = Effect.fn(function* (id: string, instanceId: string) {
        const summaries = yield* fis.listExperimentTemplates.items({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
        for (const summary of summaries) {
          if (
            summary.id !== undefined &&
            tagRecord(summary.tags)["alchemy::instance"] === instanceId &&
            (yield* hasAlchemyTags(id, summary.tags))
          ) {
            return yield* getTemplate(summary.id);
          }
        }
        return undefined;
      });

      const toAttrs = (template: fis.ExperimentTemplate) => ({
        id: template.id!,
        arn: template.arn!,
        roleArn: template.roleArn!,
      });

      // Report-capture durations are `Duration.Input`s; the FIS wire format
      // is an ISO-8601 duration string (e.g. `PT10M`). Normalize through the
      // central Duration util (handles state-persisted Duration JSON), then
      // emit hours when the duration is whole hours, else minutes, else
      // seconds, matching the canonical forms FIS reports back.
      const toIsoDuration = (
        input: Duration.Input | undefined,
      ): string | undefined => {
        if (input === undefined) return undefined;
        const seconds = toSeconds(input)!;
        if (seconds > 0 && seconds % 3600 === 0) return `PT${seconds / 3600}H`;
        if (seconds % 60 === 0) return `PT${seconds / 60}M`;
        return `PT${seconds}S`;
      };

      // Project the report configuration into the wire shape (ISO-8601
      // duration strings).
      const projectReportConfiguration = (
        config: ExperimentTemplateReportConfiguration | undefined,
      ) =>
        config
          ? {
              ...config,
              preExperimentDuration: toIsoDuration(
                config.preExperimentDuration,
              ),
              postExperimentDuration: toIsoDuration(
                config.postExperimentDuration,
              ),
            }
          : undefined;

      // The desired mutable state, projected into the wire shape that
      // `getExperimentTemplate` reports so observed-vs-desired comparison is
      // structural.
      const projectDesired = (id: string, props: ExperimentTemplateProps) => ({
        description: props.description ?? id,
        roleArn: props.roleArn,
        stopConditions: props.stopConditions ?? [{ source: "none" }],
        targets: props.targets ?? {},
        actions: props.actions,
        // Settable-but-not-removable aspects only participate in the
        // comparison while the user declares them, so dropping the prop
        // doesn't cause a perpetual (and futile) update call.
        logConfiguration: props.logConfiguration
          ? {
              ...props.logConfiguration,
              logSchemaVersion: props.logConfiguration.logSchemaVersion ?? 2,
            }
          : undefined,
        emptyTargetResolutionMode:
          props.experimentOptions?.emptyTargetResolutionMode,
        experimentReportConfiguration: projectReportConfiguration(
          props.experimentReportConfiguration,
        ),
      });

      const projectObserved = (
        template: fis.ExperimentTemplate,
        props: ExperimentTemplateProps,
      ) => ({
        description: template.description,
        roleArn: template.roleArn,
        stopConditions: template.stopConditions ?? [],
        targets: template.targets ?? {},
        actions: template.actions ?? {},
        logConfiguration: props.logConfiguration
          ? template.logConfiguration
          : undefined,
        emptyTargetResolutionMode: props.experimentOptions
          ?.emptyTargetResolutionMode
          ? template.experimentOptions?.emptyTargetResolutionMode
          : undefined,
        experimentReportConfiguration: props.experimentReportConfiguration
          ? template.experimentReportConfiguration
          : undefined,
      });

      return ExperimentTemplate.Provider.of({
        stables: ["id", "arn"],

        // Enumerate every experiment template in the ambient account/region,
        // hydrating each summary into the full attribute shape. A template
        // can vanish between enumeration and hydration; drop it.
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* fis.listExperimentTemplates.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const items = yield* Effect.forEach(
              summaries,
              (summary) =>
                summary.id === undefined
                  ? Effect.succeed(undefined)
                  : getTemplate(summary.id).pipe(
                      Effect.map((t) => (t ? toAttrs(t) : undefined)),
                    ),
              { concurrency: 10 },
            );
            return items.filter(
              (item): item is ExperimentTemplate["Attributes"] =>
                item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, instanceId, output }) {
          const template = output?.id
            ? yield* getTemplate(output.id)
            : yield* findByTags(id, instanceId);
          if (template === undefined) return undefined;
          const attrs = toAttrs(template);
          return (yield* hasAlchemyTags(id, template.tags))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          // accountTargeting is create-only — changing it replaces. Other
          // props (commonly roleArn) are unresolved Outputs during plan, so
          // narrow only the field replacement detection needs rather than
          // requiring the whole props object to be resolved.
          const newOptions = (
            news as {
              experimentOptions?: Input<ExperimentTemplateExperimentOptions>;
            }
          ).experimentOptions;
          if (newOptions !== undefined && !isResolved(newOptions)) {
            return undefined;
          }
          const oldTargeting =
            olds.experimentOptions?.accountTargeting ?? "single-account";
          const newTargeting = newOptions?.accountTargeting ?? "single-account";
          if (oldTargeting !== newTargeting) {
            return { action: "replace" } as const;
          }
          // fall through: undefined → default update
        }),

        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          output,
          session,
        }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = {
            ...news.tags,
            ...internalTags,
            "alchemy::instance": instanceId,
          };
          const desired = projectDesired(id, news);

          // 1. Observe — cloud state is authoritative; output is only an id
          // cache. Fall back to instance-scoped tag recovery when the id is
          // unknown (state persistence failure).
          let observed = output?.id ? yield* getTemplate(output.id) : undefined;
          if (observed === undefined) {
            observed = yield* findByTags(id, instanceId);
          }

          // 2. Ensure — create if missing. The clientToken is a per-request
          // idempotency token, not a physical name.
          if (observed === undefined) {
            const clientToken = yield* Effect.sync(() => crypto.randomUUID());
            observed = yield* retryRolePropagation(
              fis.createExperimentTemplate({
                clientToken,
                description: desired.description,
                stopConditions: desired.stopConditions,
                targets: desired.targets,
                actions: desired.actions,
                roleArn: news.roleArn,
                logConfiguration: desired.logConfiguration,
                experimentOptions: news.experimentOptions,
                experimentReportConfiguration:
                  desired.experimentReportConfiguration,
                tags: desiredTags,
              }),
            ).pipe(Effect.map((r) => r.experimentTemplate!));
          } else if (
            // 3a. Sync definition — compare the observed template against the
            // desired projection and apply a single update on any delta
            // (UpdateExperimentTemplate replaces the provided aspects
            // wholesale). Skip the API entirely on no-op.
            stableStringify(projectObserved(observed, news)) !==
            stableStringify(desired)
          ) {
            observed = yield* retryRolePropagation(
              fis.updateExperimentTemplate({
                id: observed.id!,
                description: desired.description,
                stopConditions: desired.stopConditions,
                targets: desired.targets,
                actions: desired.actions,
                roleArn: news.roleArn,
                logConfiguration: desired.logConfiguration,
                experimentOptions: news.experimentOptions
                  ? {
                      emptyTargetResolutionMode:
                        news.experimentOptions.emptyTargetResolutionMode,
                    }
                  : undefined,
                experimentReportConfiguration:
                  desired.experimentReportConfiguration,
              }),
            ).pipe(Effect.map((r) => r.experimentTemplate!));
          }

          // 3b. Sync tags — diff against the OBSERVED cloud tags (the create
          // path already landed them, so this is a no-op there; adoption and
          // out-of-band drift converge here).
          const arn = observed.arn!;
          const currentTags = tagRecord(observed.tags);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* fis.tagResource({
              resourceArn: arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* fis.untagResource({
              resourceArn: arn,
              tagKeys: removed,
            });
          }

          yield* session.note(observed.id!);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* fis
            .deleteExperimentTemplate({ id: output.id })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
