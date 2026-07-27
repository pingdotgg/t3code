import * as iam from "@distilled.cloud/aws/iam";
import * as sfn from "@distilled.cloud/aws/sfn";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import { compileProgram, SfnCompileError } from "./Asl/compile.ts";
import type { SfnEffect } from "./Asl/Program.ts";

/**
 * The workflow type. `STANDARD` workflows are durable (up to one year),
 * exactly-once, and support execution history; `EXPRESS` workflows are
 * high-throughput, at-least-once, cheaper, and support synchronous
 * invocation via `StartSyncExecution`.
 */
export type StateMachineType = "STANDARD" | "EXPRESS";

/**
 * Log level for a state machine's CloudWatch Logs configuration.
 */
export type StateMachineLogLevel = "ALL" | "ERROR" | "FATAL" | "OFF";

export interface StateMachineLogging {
  /**
   * Which execution history events are logged.
   */
  level: StateMachineLogLevel;
  /**
   * Whether execution input, data passed between states, and output are
   * included in the log events.
   * @default false
   */
  includeExecutionData?: boolean;
  /**
   * CloudWatch log group ARNs to deliver logs to. The `:*` suffix is
   * appended automatically when missing (the API requires it).
   */
  destinations?: string[];
}

export interface StateMachineProps {
  /**
   * Name of the state machine (1-80 characters; letters, digits, dashes and
   * underscores). If omitted, a deterministic physical name is generated
   * from the app, stage, and logical ID. Changing the name triggers a
   * replacement.
   */
  stateMachineName?: string;
  /**
   * The Amazon States Language (ASL) definition of the workflow. Accepts a
   * plain object (recommended — `Output` values such as function ARNs are
   * resolved before serialization) or a pre-serialized JSON string.
   */
  definition: Record<string, unknown> | string;
  /**
   * Literal substitutions applied to the serialized definition: every
   * occurrence of `${key}` is replaced with the mapped value. Useful when
   * the definition is authored as a static JSON string.
   */
  definitionSubstitutions?: Record<string, string>;
  /**
   * The ARN of an existing IAM role for the state machine to use. When
   * omitted, an execution role is created automatically with
   * `states.amazonaws.com` trust; `lambda:InvokeFunction` is granted for
   * every Lambda function ARN referenced in the definition, and
   * {@link StateMachineProps.policyStatements} are attached as an inline
   * policy.
   */
  roleArn?: string;
  /**
   * Additional IAM policy statements attached to the auto-created
   * execution role (ignored when {@link StateMachineProps.roleArn} is
   * provided). Use this to authorize service integrations such as
   * `sqs:SendMessage` or `dynamodb:PutItem` task states.
   */
  policyStatements?: PolicyStatement[];
  /**
   * The workflow type. Changing the type triggers a replacement.
   * @default "STANDARD"
   */
  type?: StateMachineType;
  /**
   * CloudWatch Logs configuration. Required (with level `ALL`/`ERROR`/
   * `FATAL`) to observe `EXPRESS` workflow executions. The auto-created
   * execution role is granted the CloudWatch Logs delivery permissions
   * automatically.
   */
  logging?: StateMachineLogging;
  /**
   * Whether AWS X-Ray tracing is enabled.
   * @default false
   */
  tracingEnabled?: boolean;
  /**
   * Tags to apply to the state machine. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface StateMachine extends Resource<
  "AWS.StepFunctions.StateMachine",
  StateMachineProps,
  {
    /**
     * Physical name of the state machine.
     */
    stateMachineName: string;
    /**
     * ARN of the state machine — pass it to `StartExecution` or reference it
     * from other workflows.
     */
    stateMachineArn: string;
    /**
     * Workflow type (`STANDARD` or `EXPRESS`).
     */
    type: StateMachineType;
    /**
     * ARN of the IAM execution role the workflow assumes.
     */
    roleArn: string;
    /**
     * Name of the auto-created execution role. `undefined` when an explicit
     * {@link StateMachineProps.roleArn} is used.
     */
    roleName: string | undefined;
  },
  {
    /**
     * IAM policy statements bindings attach to the auto-created execution
     * role (e.g. service-integration permissions collected by `fromProgram`).
     */
    policyStatements: PolicyStatement[];
  },
  Providers
> {}

/**
 * The definition failed AWS's `validateStateMachineDefinition` pre-flight
 * check (run in reconcile before create/update). Carries the validator's
 * ERROR-severity diagnostics.
 */
export class InvalidStateMachineDefinition extends Data.TaggedError(
  "InvalidStateMachineDefinition",
)<{
  readonly diagnostics: readonly {
    readonly severity: string;
    readonly code: string;
    readonly message: string;
    readonly location: string | undefined;
  }[];
}> {}

const StateMachineResource = Resource<StateMachine>(
  "AWS.StepFunctions.StateMachine",
);

/**
 * Props for {@link StateMachine.fromProgram} — everything a raw
 * `StateMachine` accepts except the `definition` (which is compiled from
 * the program). User `policyStatements` are merged with the statements the
 * compiler collects from `Sfn.invoke`/`Sfn.integrate` task states.
 */
export interface FromProgramProps extends Omit<
  StateMachineProps,
  "definition" | "definitionSubstitutions"
> {
  /** The typed Step Functions program to compile (built with `Sfn.gen`). */
  program: SfnEffect<any, any>;
}

/**
 * Sugar over the raw `StateMachine` resource: compile a typed `Sfn` program
 * to a plain ASL definition object plus collected IAM policy statements,
 * then register the same `StateMachine` resource the raw path uses. Nothing
 * engine-level — the raw `definition` escape hatch stays first-class.
 */
const fromProgram = (id: string, props: FromProgramProps) =>
  Effect.gen(function* () {
    const { program, policyStatements, ...rest } = props;
    const compiled = yield* Effect.try({
      try: () => compileProgram(program),
      catch: (error) =>
        error instanceof SfnCompileError
          ? error
          : new SfnCompileError({ message: String(error) }),
    });
    return yield* StateMachineResource(id, {
      ...rest,
      definition: compiled.definition,
      policyStatements: [
        ...compiled.policyStatements,
        ...(policyStatements ?? []),
      ],
    });
  });

/**
 * An AWS Step Functions state machine (workflow).
 *
 * `StateMachine` owns the lifecycle of a `STANDARD` or `EXPRESS` workflow.
 * The Amazon States Language definition may be provided as a plain object —
 * `Output` values (like Lambda function ARNs) inside it are resolved before
 * serialization — and an execution role is created automatically unless an
 * explicit `roleArn` is given. Lambda functions referenced in the definition
 * are granted `lambda:InvokeFunction` on the auto-created role.
 * @resource
 * @section Creating State Machines
 * @example Standard Workflow with a Pass State
 * ```typescript
 * import * as StepFunctions from "alchemy/AWS/StepFunctions";
 *
 * const machine = yield* StepFunctions.StateMachine("OrderWorkflow", {
 *   definition: {
 *     StartAt: "Done",
 *     States: {
 *       Done: { Type: "Pass", End: true },
 *     },
 *   },
 * });
 * ```
 *
 * @example Express Workflow
 * ```typescript
 * const machine = yield* StepFunctions.StateMachine("FastWorkflow", {
 *   type: "EXPRESS",
 *   definition: {
 *     StartAt: "Echo",
 *     States: {
 *       Echo: { Type: "Pass", End: true },
 *     },
 *   },
 * });
 * ```
 *
 * @section Orchestrating Lambda Functions
 * Reference a function ARN in a Task state — `lambda:InvokeFunction` is
 * granted on the auto-created execution role automatically.
 *
 * @example Invoke a Lambda Function
 * ```typescript
 * const machine = yield* StepFunctions.StateMachine("Pipeline", {
 *   definition: {
 *     StartAt: "Process",
 *     States: {
 *       Process: {
 *         Type: "Task",
 *         Resource: fn.functionArn,
 *         End: true,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @section Service Integrations
 * @example Send a Task Token to SQS (callback pattern)
 * ```typescript
 * const machine = yield* StepFunctions.StateMachine("Callback", {
 *   definition: {
 *     StartAt: "WaitForApproval",
 *     States: {
 *       WaitForApproval: {
 *         Type: "Task",
 *         Resource: "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
 *         Parameters: {
 *           QueueUrl: queue.queueUrl,
 *           MessageBody: { "token.$": "$$.Task.Token" },
 *         },
 *         End: true,
 *       },
 *     },
 *   },
 *   policyStatements: [
 *     {
 *       Effect: "Allow",
 *       Action: ["sqs:SendMessage"],
 *       Resource: [queue.queueArn],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Starting Executions at Runtime
 * Bind execution operations in the init phase and use them in runtime
 * handlers.
 *
 * @example Start a workflow from a handler
 * ```typescript
 * // init
 * const startExecution = yield* StepFunctions.StartExecution(machine);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const execution = yield* startExecution({
 *       input: JSON.stringify({ orderId: "123" }),
 *     });
 *     return HttpServerResponse.json({ executionArn: execution.executionArn });
 *   }),
 * };
 * ```
 *
 * @example Run an EXPRESS workflow synchronously
 * ```typescript
 * // init
 * const startSyncExecution = yield* StepFunctions.StartSyncExecution(machine);
 *
 * // runtime
 * const result = yield* startSyncExecution({
 *   input: JSON.stringify({ value: 21 }),
 * });
 * // result.status === "SUCCEEDED", result.output is the workflow output
 * ```
 *
 * @section Typed Programs
 * Author the workflow as a typed `Sfn` program (mirroring Effect's names —
 * `Sfn.gen`, `Sfn.invoke`, `Sfn.when`, `Sfn.forEach`, `Sfn.catchTag`, ...)
 * and compile it with `StateMachine.fromProgram`. The compiler emits a plain
 * ASL definition plus the IAM policy statements its task states need; the
 * raw `definition` path above stays fully usable underneath.
 *
 * @example Compile a typed program
 * ```typescript
 * import { Sfn, StateMachine } from "alchemy/AWS/StepFunctions";
 *
 * const machine = yield* StateMachine.fromProgram("OrderWorkflow", {
 *   type: "EXPRESS",
 *   program: Sfn.gen(function* (input: Sfn.Expr<{ value: number }>) {
 *     const result = yield* Sfn.invoke<{ doubled: number }>(doubler, {
 *       value: input.value,
 *     });
 *     const size = yield* Sfn.when(
 *       Sfn.gt(result.doubled, 10),
 *       Sfn.succeed("big"),
 *       Sfn.succeed("small"),
 *     );
 *     return { doubled: result.doubled, size };
 *   }),
 * });
 * ```
 */
export const StateMachine: typeof StateMachineResource & {
  fromProgram: typeof fromProgram;
} = Object.assign(StateMachineResource, { fromProgram });

/** Normalize a plain or redacted string to its plain value. */
const plain = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

/** Convert a tag record to the SFN wire shape (lowercase key/value). */
const toSfnTags = (tags: Record<string, string>): sfn.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

/** Convert an SFN wire tag list back to a record. */
const fromSfnTags = (
  tags: ReadonlyArray<sfn.Tag> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { key: string; value: string } =>
          typeof tag.key === "string" && typeof tag.value === "string",
      )
      .map((tag) => [tag.key, tag.value]),
  );

/**
 * Serialize the desired definition to its ASL JSON string, applying
 * `${key}` substitutions.
 */
const serializeDefinition = (props: {
  definition: Record<string, unknown> | string;
  definitionSubstitutions?: Record<string, string>;
}): string => {
  let definition =
    typeof props.definition === "string"
      ? props.definition
      : JSON.stringify(props.definition, null, 2);
  for (const [key, value] of Object.entries(
    props.definitionSubstitutions ?? {},
  )) {
    definition = definition.replaceAll(`\${${key}}`, value);
  }
  return definition;
};

/**
 * Canonicalize an ASL JSON string for drift comparison (whitespace/key-order
 * insensitive). Falls back to the raw string when unparsable.
 */
const normalizeDefinition = (definition: string): string => {
  try {
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, stable(v)]),
            )
          : value;
    return JSON.stringify(stable(JSON.parse(definition)));
  } catch {
    return definition;
  }
};

/**
 * Extract every Lambda function ARN referenced in a serialized definition so
 * the auto-created execution role can be granted `lambda:InvokeFunction`.
 */
const scanLambdaArns = (definition: string): string[] => {
  const matches = definition.match(
    /arn:aws[a-z0-9-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_$-]+)?/g,
  );
  return [...new Set(matches ?? [])];
};

/**
 * CloudWatch Logs delivery permissions required by Step Functions logging.
 * These actions do not support resource-level scoping.
 */
const LOG_DELIVERY_ACTIONS = [
  "logs:CreateLogDelivery",
  "logs:CreateLogStream",
  "logs:GetLogDelivery",
  "logs:UpdateLogDelivery",
  "logs:DeleteLogDelivery",
  "logs:ListLogDeliveries",
  "logs:PutLogEvents",
  "logs:PutResourcePolicy",
  "logs:DescribeResourcePolicies",
  "logs:DescribeLogGroups",
];

/** Map the `logging` prop to the wire `LoggingConfiguration`. */
const toWireLogging = (
  logging: StateMachineLogging | undefined,
): sfn.LoggingConfiguration | undefined =>
  logging === undefined
    ? undefined
    : {
        level: logging.level,
        includeExecutionData: logging.includeExecutionData ?? false,
        destinations: (logging.destinations ?? []).map((arn) => ({
          cloudWatchLogsLogGroup: {
            logGroupArn: arn.endsWith(":*") ? arn : `${arn}:*`,
          },
        })),
      };

/** Compare observed logging configuration against the desired one. */
const loggingDrifted = (
  observed: sfn.LoggingConfiguration | undefined,
  desired: sfn.LoggingConfiguration | undefined,
): boolean => {
  const observedLevel = observed?.level ?? "OFF";
  const desiredLevel = desired?.level ?? "OFF";
  if (observedLevel !== desiredLevel) return true;
  if (desiredLevel === "OFF") return false;
  if (
    (observed?.includeExecutionData ?? false) !==
    (desired?.includeExecutionData ?? false)
  ) {
    return true;
  }
  const arnsOf = (config: sfn.LoggingConfiguration | undefined) =>
    (config?.destinations ?? [])
      .map((d) => d.cloudWatchLogsLogGroup?.logGroupArn ?? "")
      .sort()
      .join(",");
  return arnsOf(observed) !== arnsOf(desired);
};

/**
 * IAM changes (new roles, fresh trust policies) propagate to Step Functions
 * eventually; a create right after role creation can transiently fail with
 * `AccessDeniedException`. Bounded retry, explicitly typed so declaration
 * emit never widens the provider layer (see PATTERNS §7).
 */
const retryWhileRolePropagates = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "AccessDeniedException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

/**
 * A state machine of the same name may still be `DELETING` from a prior
 * destroy; creation returns the typed `StateMachineDeleting` until the
 * deletion completes. Bounded retry (~60s).
 */
const retryWhileDeleting = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "StateMachineDeleting",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

export const StateMachineProvider = () =>
  Provider.effect(
    StateMachine,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<StateMachineProps, "stateMachineName">,
      ) {
        return (
          props.stateMachineName ??
          (yield* createPhysicalName({ id, maxLength: 80 }))
        );
      });

      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      const createPolicyName = (id: string) =>
        createPhysicalName({ id, maxLength: 128 });

      const stateMachineArnOf = (
        region: string,
        accountId: string,
        name: string,
      ) => `arn:aws:states:${region}:${accountId}:stateMachine:${name}`;

      const describeOrUndefined = Effect.fn(function* (
        stateMachineArn: string,
      ) {
        return yield* sfn
          .describeStateMachine({ stateMachineArn })
          .pipe(
            Effect.catchTag("StateMachineDoesNotExist", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /**
       * Pre-flight the serialized definition through the vendor validator
       * so a definitively invalid document fails with typed diagnostics
       * before any create/update call. Best-effort: if the validate call
       * itself fails (missing IAM permission, throttling), reconcile
       * proceeds and create/updateStateMachine remains the authority.
       */
      const preflightValidateDefinition = Effect.fn(function* (
        definition: string,
        type: StateMachineType,
      ) {
        const report = yield* sfn
          .validateStateMachineDefinition({
            definition,
            type,
            severity: "ERROR",
          })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (report !== undefined && report.result === "FAIL") {
          return yield* Effect.fail(
            new InvalidStateMachineDefinition({
              diagnostics: report.diagnostics.map((diagnostic) => ({
                severity: diagnostic.severity,
                code: plain(diagnostic.code),
                message: plain(diagnostic.message),
                location:
                  diagnostic.location === undefined
                    ? undefined
                    : plain(diagnostic.location),
              })),
            }),
          );
        }
      });

      const fetchObservedTags = Effect.fn(function* (resourceArn: string) {
        return yield* sfn.listTagsForResource({ resourceArn }).pipe(
          Effect.map((r) => fromSfnTags(r.tags)),
          Effect.catchTag("ResourceNotFound", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      /**
       * Compute the full inline-policy statement list for the auto-created
       * execution role: Lambda invoke grants scanned from the definition,
       * user statements, binding-contributed statements, and CloudWatch
       * Logs delivery permissions when logging is enabled.
       */
      const buildRolePolicyStatements = (
        definition: string,
        news: StateMachineProps,
        bindings: ResourceBinding<StateMachine["Binding"]>[],
      ): PolicyStatement[] => {
        const statements: PolicyStatement[] = [];
        const lambdaArns = scanLambdaArns(definition);
        if (lambdaArns.length > 0) {
          statements.push({
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [
              ...lambdaArns,
              // cover qualified invocations (versions/aliases)
              ...lambdaArns
                .filter((arn) => !/:function:[^:]+:/.test(arn))
                .map((arn) => `${arn}:*`),
            ],
          });
        }
        if (news.logging && news.logging.level !== "OFF") {
          statements.push({
            Effect: "Allow",
            Action: LOG_DELIVERY_ACTIONS,
            Resource: ["*"],
          });
        }
        if (news.tracingEnabled) {
          statements.push({
            Effect: "Allow",
            Action: [
              "xray:PutTraceSegments",
              "xray:PutTelemetryRecords",
              "xray:GetSamplingRules",
              "xray:GetSamplingTargets",
            ],
            Resource: ["*"],
          });
        }
        statements.push(...(news.policyStatements ?? []));
        statements.push(...bindings.flatMap((b) => b.data.policyStatements));
        return statements;
      };

      /**
       * Ensure the auto-created execution role exists with the
       * `states.amazonaws.com` trust policy and the desired inline policy.
       * Idempotent: tolerates the role already existing and converges the
       * inline policy on every reconcile.
       */
      const ensureExecutionRole = Effect.fn(function* ({
        id,
        roleName,
        policyName,
        statements,
      }: {
        id: string;
        roleName: string;
        policyName: string;
        statements: PolicyStatement[];
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "states.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }),
            ),
          );

        if (statements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: statements,
            }),
          });
        } else {
          yield* iam
            .deleteRolePolicy({ RoleName: roleName, PolicyName: policyName })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return role.Role.Arn;
      });

      return StateMachine.Provider.of({
        stables: ["stateMachineName", "stateMachineArn", "type"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* sfn.listStateMachines
              .pages({})
              .pipe(Stream.runCollect);
            const items = Array.from(pages).flatMap(
              (page) => page.stateMachines ?? [],
            );
            const results = yield* Effect.forEach(
              items,
              (item) =>
                sfn
                  .describeStateMachine({
                    stateMachineArn: item.stateMachineArn,
                  })
                  .pipe(
                    // name/roleArn are optional on the wire; a machine
                    // missing either cannot be expressed as Attributes.
                    Effect.map((machine) =>
                      machine.name != null &&
                      machine.stateMachineArn != null &&
                      machine.roleArn != null
                        ? {
                            stateMachineName: machine.name,
                            stateMachineArn: machine.stateMachineArn,
                            type: machine.type as StateMachineType,
                            roleArn: machine.roleArn,
                            roleName: undefined as string | undefined,
                          }
                        : undefined,
                    ),
                    Effect.catchTag("StateMachineDoesNotExist", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              { concurrency: 5 },
            );
            return results.filter(
              (item): item is StateMachine["Attributes"] => item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.stateMachineName ?? (yield* createName(id, olds ?? {}));
          const stateMachineArn =
            output?.stateMachineArn ??
            stateMachineArnOf(region, accountId, name);
          const found = yield* describeOrUndefined(stateMachineArn);
          if (!found || found.status === "DELETING") return undefined;
          const attrs = {
            stateMachineName: found.name,
            stateMachineArn: found.stateMachineArn,
            type: found.type as StateMachineType,
            roleArn: found.roleArn,
            roleName: output?.roleName,
          };
          const tags = yield* fetchObservedTags(stateMachineArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if ((olds?.type ?? "STANDARD") !== (news?.type ?? "STANDARD")) {
            return { action: "replace" } as const;
          }
          // definition/role/logging/tracing/tags converge via update
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          bindings,
        }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.stateMachineName ?? (yield* createName(id, news));
          const stateMachineArn = stateMachineArnOf(region, accountId, name);
          const type = (news.type ?? "STANDARD") as StateMachineType;
          const definition = serializeDefinition(news);
          const desiredLogging = toWireLogging(news.logging);
          const desiredTracing = { enabled: news.tracingEnabled ?? false };
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Pre-flight: fail with typed diagnostics before touching IAM or
          // the machine when the definition is definitively invalid.
          yield* preflightValidateDefinition(definition, type);

          // Ensure the execution role first — the machine cannot exist
          // without one. Managed unless an explicit roleArn is provided.
          let roleArn = news.roleArn;
          let roleName: string | undefined;
          if (roleArn === undefined) {
            roleName = yield* createRoleName(id);
            const policyName = yield* createPolicyName(id);
            roleArn = yield* ensureExecutionRole({
              id,
              roleName,
              policyName,
              statements: buildRolePolicyStatements(definition, news, bindings),
            });
          }

          // 1. OBSERVE — cloud state is authoritative; `output` is only a
          //    name cache. A machine still DELETING from a prior destroy
          //    must finish deleting before we can recreate it.
          const observed = yield* describeOrUndefined(stateMachineArn).pipe(
            Effect.map((machine) =>
              machine?.status === "DELETING" ? undefined : machine,
            ),
          );

          if (observed === undefined) {
            // 2. ENSURE — create; tolerate the concurrent-create race and
            //    wait out a same-name deletion or IAM propagation delay.
            yield* retryWhileRolePropagates(
              retryWhileDeleting(
                sfn
                  .createStateMachine({
                    name,
                    definition,
                    roleArn,
                    type,
                    loggingConfiguration: desiredLogging,
                    tracingConfiguration: desiredTracing,
                    tags: toSfnTags(desiredTags),
                  })
                  .pipe(
                    Effect.catchTag("StateMachineAlreadyExists", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              ),
            );
          } else {
            // 3. SYNC — diff OBSERVED cloud state against desired and issue
            //    a single update only when something actually drifted.
            const drifted =
              normalizeDefinition(plain(observed.definition)) !==
                normalizeDefinition(definition) ||
              observed.roleArn !== roleArn ||
              loggingDrifted(observed.loggingConfiguration, desiredLogging) ||
              (observed.tracingConfiguration?.enabled ?? false) !==
                desiredTracing.enabled;
            if (drifted) {
              yield* retryWhileRolePropagates(
                sfn.updateStateMachine({
                  stateMachineArn,
                  definition,
                  roleArn,
                  loggingConfiguration: desiredLogging ?? { level: "OFF" },
                  tracingConfiguration: desiredTracing,
                }),
              );
              // Updates propagate eventually (typically seconds). Poll the
              // describe endpoint (bounded) so subsequent reads observe the
              // new revision; proceed best-effort if it hasn't settled.
              yield* describeOrUndefined(stateMachineArn).pipe(
                Effect.repeat({
                  schedule: Schedule.fixed("1 second"),
                  until: (machine) =>
                    machine === undefined ||
                    normalizeDefinition(plain(machine.definition)) ===
                      normalizeDefinition(definition),
                  times: 20,
                }),
              );
            }
          }

          // 3b. SYNC TAGS — against OBSERVED cloud tags so adoption
          //     converges (create-time tags only apply on first create).
          const observedTags = yield* fetchObservedTags(stateMachineArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* sfn.tagResource({
              resourceArn: stateMachineArn,
              tags: upsert.map(({ Key, Value }) => ({
                key: Key,
                value: Value,
              })),
            });
          }
          if (removed.length > 0) {
            yield* sfn.untagResource({
              resourceArn: stateMachineArn,
              tagKeys: removed,
            });
          }

          yield* session.note(stateMachineArn);
          return {
            stateMachineName: name,
            stateMachineArn,
            type,
            roleArn,
            roleName,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteStateMachine is idempotent (no error when already gone)
          // and asynchronous — the machine transitions through DELETING.
          yield* sfn.deleteStateMachine({
            stateMachineArn: output.stateMachineArn,
          });

          // Tear down the managed execution role (absent when the user
          // supplied an explicit roleArn). Every step tolerates the role
          // being partially or fully gone already.
          if (output.roleName !== undefined) {
            const roleName = output.roleName;
            yield* iam.listRolePolicies.items({ RoleName: roleName }).pipe(
              Stream.mapEffect((policyName) =>
                iam
                  .deleteRolePolicy({
                    RoleName: roleName,
                    PolicyName: policyName,
                  })
                  .pipe(
                    Effect.catchTag("NoSuchEntityException", () => Effect.void),
                  ),
              ),
              Stream.runDrain,
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );
            yield* iam
              .deleteRole({ RoleName: roleName })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }),
      });
    }),
  );
