import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import {
  AgentCoreProvisioningFailed,
  createAgentCoreName,
  readAgentCoreTags,
  retryWhileConflict,
  retryWhileValidation,
  syncAgentCoreTags,
  unredact,
} from "./internal.ts";

/**
 * The deployable artifact of an agent runtime — a container image in ECR or
 * a managed-runtime code bundle in S3. Passed through to the AgentCore API
 * unchanged — see the AWS SDK `AgentRuntimeArtifact` shape.
 */
export type RuntimeArtifact = control.AgentRuntimeArtifact;

export interface RuntimeProps {
  /**
   * Name of the agent runtime. Must match `[a-zA-Z][a-zA-Z0-9_]{0,47}`
   * (underscores, no hyphens). If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Changing the name triggers
   * a replacement.
   */
  agentRuntimeName?: string;
  /**
   * A description of the agent runtime.
   */
  description?: string;
  /**
   * The deployable artifact: `{ containerConfiguration: { containerUri } }`
   * for an ECR image, or `{ codeConfiguration: ... }` for a managed-runtime
   * code bundle.
   */
  agentRuntimeArtifact: RuntimeArtifact;
  /**
   * The ARN of an IAM role the runtime assumes. Must trust
   * `bedrock-agentcore.amazonaws.com`.
   */
  roleArn: string;
  /**
   * Network access for the runtime.
   * @default { networkMode: "PUBLIC" }
   */
  networkConfiguration?: control.NetworkConfiguration;
  /**
   * The protocol the hosted agent serves (`HTTP`, `MCP`, or `A2A`).
   */
  protocolConfiguration?: control.ProtocolConfiguration;
  /**
   * Inbound authorization for `InvokeAgentRuntime` (JWT bearer tokens).
   * Omit for SigV4 (IAM).
   */
  authorizerConfiguration?: control.AuthorizerConfiguration;
  /**
   * Request headers forwarded to the agent container.
   */
  requestHeaderConfiguration?: control.RequestHeaderConfiguration;
  /**
   * Idle-session and max-lifetime configuration.
   */
  lifecycleConfiguration?: control.LifecycleConfiguration;
  /**
   * Environment variables injected into the agent container.
   */
  environmentVariables?: Record<string, string>;
  /**
   * Tags to apply to the runtime. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Runtime extends Resource<
  "AWS.BedrockAgentCore.Runtime",
  RuntimeProps,
  {
    /**
     * The unique identifier of the agent runtime.
     */
    agentRuntimeId: string;
    /**
     * The ARN of the agent runtime.
     */
    agentRuntimeArn: string;
    /**
     * The current version of the agent runtime (bumped on every update).
     */
    agentRuntimeVersion: string;
    /**
     * Name of the agent runtime.
     */
    agentRuntimeName: string;
    /**
     * Current status of the agent runtime (e.g. `READY`).
     */
    status: string;
  }
> {}

/**
 * An Amazon Bedrock AgentCore Runtime — serverless hosting for containerized
 * AI agents.
 *
 * A runtime deploys an agent (an ECR container image or managed-runtime code
 * bundle) behind the `InvokeAgentRuntime` data-plane API with session
 * isolation, scaling, and identity built in. Each configuration change
 * publishes a new immutable runtime version.
 *
 * @resource
 * @section Creating Runtimes
 * @example Container-Backed Agent Runtime
 * ```typescript
 * import * as AgentCore from "alchemy/AWS/BedrockAgentCore";
 *
 * const runtime = yield* AgentCore.Runtime("MyAgent", {
 *   agentRuntimeArtifact: {
 *     containerConfiguration: {
 *       containerUri: `${account}.dkr.ecr.us-west-2.amazonaws.com/my-agent:latest`,
 *     },
 *   },
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @section Invoking from a Function
 * @example Invoke the Agent
 * ```typescript
 * // init
 * const invoke = yield* AgentCore.InvokeAgentRuntime(runtime);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const response = yield* invoke({
 *       runtimeSessionId: "session-0000000000000000000000000000000001",
 *       payload: JSON.stringify({ prompt: "hello" }),
 *     });
 *     return HttpServerResponse.json({ contentType: response.contentType });
 *   }),
 * };
 * ```
 */
export const Runtime = Resource<Runtime>("AWS.BedrockAgentCore.Runtime");

/** Statuses indicating an in-flight transition to wait out. */
const RUNTIME_TRANSIENT = new Set(["CREATING", "UPDATING"]);

export const RuntimeProvider = () =>
  Provider.effect(
    Runtime,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<RuntimeProps, "agentRuntimeName">,
      ) {
        return props.agentRuntimeName ?? (yield* createAgentCoreName(id));
      });

      const getRuntimeOrUndefined = Effect.fn(function* (
        agentRuntimeId: string,
      ) {
        return yield* control
          .getAgentRuntime({ agentRuntimeId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByName = Effect.fn(function* (name: string) {
        const pages = yield* control.listAgentRuntimes
          .pages({})
          .pipe(Stream.runCollect);
        const summary = Array.from(pages)
          .flatMap((page) => page.agentRuntimes ?? [])
          .find((s) => s.agentRuntimeName === name);
        return summary === undefined
          ? undefined
          : yield* getRuntimeOrUndefined(summary.agentRuntimeId);
      });

      const waitForSettled = Effect.fn(function* (agentRuntimeId: string) {
        return yield* getRuntimeOrUndefined(agentRuntimeId).pipe(
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (r) => r === undefined || !RUNTIME_TRANSIENT.has(r.status),
            times: 60,
          }),
        );
      });

      const toAttributes = (runtime: control.GetAgentRuntimeResponse) => ({
        agentRuntimeId: runtime.agentRuntimeId,
        agentRuntimeArn: runtime.agentRuntimeArn,
        agentRuntimeVersion: runtime.agentRuntimeVersion,
        agentRuntimeName: runtime.agentRuntimeName,
        status: runtime.status,
      });

      return Runtime.Provider.of({
        stables: ["agentRuntimeId", "agentRuntimeArn", "agentRuntimeName"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* control.listAgentRuntimes
              .pages({})
              .pipe(Stream.runCollect);
            const summaries = Array.from(pages).flatMap(
              (page) => page.agentRuntimes ?? [],
            );
            const hydrated = yield* Effect.forEach(
              summaries,
              (s) => getRuntimeOrUndefined(s.agentRuntimeId),
              { concurrency: 5 },
            );
            return hydrated.filter((r) => r !== undefined).map(toAttributes);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const runtime = output?.agentRuntimeId
            ? yield* getRuntimeOrUndefined(output.agentRuntimeId)
            : yield* findByName(
                yield* createName(id, olds ?? ({} as RuntimeProps)),
              );
          if (runtime === undefined || runtime.status === "DELETING") {
            return undefined;
          }
          const attrs = toAttributes(runtime);
          const tags = yield* readAgentCoreTags(runtime.agentRuntimeArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? ({} as RuntimeProps));
          const newName = yield* createName(id, news ?? ({} as RuntimeProps));
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // artifact, role, network, protocol, env vars, and tags converge
          // via update (each update publishes a new runtime version).
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? ({} as RuntimeProps);
          const name =
            output?.agentRuntimeName ?? (yield* createName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };
          const networkConfiguration = props.networkConfiguration ?? {
            networkMode: "PUBLIC",
          };

          // 1. OBSERVE
          let runtime = output?.agentRuntimeId
            ? yield* getRuntimeOrUndefined(output.agentRuntimeId)
            : undefined;
          if (runtime === undefined) {
            runtime = yield* findByName(name);
          }

          // 2. ENSURE — a freshly created IAM role is not instantly
          // assumable; ride out the transient ValidationException and the
          // name-exists conflict race.
          if (runtime === undefined) {
            const created = yield* control
              .createAgentRuntime({
                agentRuntimeName: name,
                description: props.description,
                agentRuntimeArtifact: props.agentRuntimeArtifact,
                roleArn: props.roleArn,
                networkConfiguration,
                protocolConfiguration: props.protocolConfiguration,
                authorizerConfiguration: props.authorizerConfiguration,
                requestHeaderConfiguration: props.requestHeaderConfiguration,
                lifecycleConfiguration: props.lifecycleConfiguration,
                environmentVariables: props.environmentVariables,
                tags: desiredTags,
              })
              .pipe(
                retryWhileValidation,
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            runtime =
              created === undefined
                ? yield* findByName(name)
                : yield* getRuntimeOrUndefined(created.agentRuntimeId);
          }
          if (runtime === undefined) {
            return yield* new AgentCoreProvisioningFailed({
              message: `agent runtime '${name}' was neither created nor found`,
            });
          }

          runtime = (yield* waitForSettled(runtime.agentRuntimeId)) ?? runtime;
          if (
            runtime.status === "CREATE_FAILED" ||
            runtime.status === "UPDATE_FAILED"
          ) {
            return yield* new AgentCoreProvisioningFailed({
              message: `agent runtime '${name}' failed: ${runtime.failureReason ?? "unknown"}`,
            });
          }

          // 3. SYNC — converge mutable settings from OBSERVED state. Each
          // update publishes a new immutable runtime version.
          const drifted =
            (unredact(runtime.description) ?? undefined) !==
              (props.description ?? unredact(runtime.description)) ||
            runtime.roleArn !== props.roleArn ||
            JSON.stringify(runtime.agentRuntimeArtifact ?? null) !==
              JSON.stringify(props.agentRuntimeArtifact) ||
            JSON.stringify(runtime.networkConfiguration) !==
              JSON.stringify(networkConfiguration) ||
            JSON.stringify(runtime.environmentVariables ?? {}) !==
              JSON.stringify(props.environmentVariables ?? {}) ||
            (props.protocolConfiguration !== undefined &&
              JSON.stringify(runtime.protocolConfiguration ?? null) !==
                JSON.stringify(props.protocolConfiguration)) ||
            (props.lifecycleConfiguration !== undefined &&
              JSON.stringify(runtime.lifecycleConfiguration ?? null) !==
                JSON.stringify(props.lifecycleConfiguration));
          if (drifted) {
            yield* control
              .updateAgentRuntime({
                agentRuntimeId: runtime.agentRuntimeId,
                description: props.description,
                agentRuntimeArtifact: props.agentRuntimeArtifact,
                roleArn: props.roleArn,
                networkConfiguration,
                protocolConfiguration: props.protocolConfiguration,
                authorizerConfiguration: props.authorizerConfiguration,
                requestHeaderConfiguration: props.requestHeaderConfiguration,
                lifecycleConfiguration: props.lifecycleConfiguration,
                environmentVariables: props.environmentVariables,
              })
              .pipe(retryWhileConflict);
            runtime =
              (yield* waitForSettled(runtime.agentRuntimeId)) ?? runtime;
          }

          // 3b. SYNC TAGS against observed cloud tags.
          yield* syncAgentCoreTags(runtime.agentRuntimeArn, desiredTags);

          // 4. RETURN fresh attributes.
          yield* session.note(runtime.agentRuntimeId);
          return toAttributes(runtime);
        }),

        // A runtime with live endpoints rejects deletion with a
        // ConflictException until they are gone.
        delete: Effect.fn(function* ({ output }) {
          yield* control
            .deleteAgentRuntime({ agentRuntimeId: output.agentRuntimeId })
            .pipe(
              retryWhileConflict,
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          yield* control
            .getAgentRuntime({ agentRuntimeId: output.agentRuntimeId })
            .pipe(
              Effect.map((r) => r.status as string),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed("GONE" as string),
              ),
              Effect.repeat({
                schedule: Schedule.fixed("5 seconds"),
                until: (status) => status === "GONE",
                times: 36,
              }),
            );
        }),
      });
    }),
  );
