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
  createGatewayName,
  readAgentCoreTags,
  retryWhileConflict,
  retryWhileValidation,
  syncAgentCoreTags,
  unredact,
} from "./internal.ts";

export interface GatewayProps {
  /**
   * Name of the gateway. Must match `([0-9a-zA-Z][-]?){1,100}` (hyphens
   * allowed, never consecutive). If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Changing the name triggers
   * a replacement.
   */
  name?: string;
  /**
   * A description of the gateway.
   */
  description?: string;
  /**
   * The ARN of an IAM role the gateway assumes to invoke its targets. Must
   * trust `bedrock-agentcore.amazonaws.com`.
   */
  roleArn: string;
  /**
   * The protocol the gateway speaks to callers.
   * @default "MCP"
   */
  protocolType?: control.GatewayProtocolType;
  /**
   * Protocol-specific configuration (MCP instructions, search, supported
   * versions). Passed through to the AgentCore API unchanged.
   */
  protocolConfiguration?: control.GatewayProtocolConfiguration;
  /**
   * How inbound callers are authorized. `AWS_IAM` uses SigV4; `CUSTOM_JWT`
   * requires `authorizerConfiguration`.
   * @default "AWS_IAM"
   */
  authorizerType?: control.AuthorizerType;
  /**
   * Authorizer configuration (JWT discovery URL, allowed audiences/clients).
   * Required when `authorizerType` is `CUSTOM_JWT`.
   */
  authorizerConfiguration?: control.AuthorizerConfiguration;
  /**
   * The ARN of a KMS key used to encrypt gateway data.
   */
  kmsKeyArn?: string;
  /**
   * Set to `DEBUG` to surface detailed exception traces to callers.
   */
  exceptionLevel?: control.ExceptionLevel;
  /**
   * Tags to apply to the gateway. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Gateway extends Resource<
  "AWS.BedrockAgentCore.Gateway",
  GatewayProps,
  {
    /**
     * The unique identifier of the gateway.
     */
    gatewayId: string;
    /**
     * The ARN of the gateway.
     */
    gatewayArn: string;
    /**
     * The MCP endpoint URL clients connect to (available once the gateway is
     * `READY`).
     */
    gatewayUrl: string | undefined;
    /**
     * Name of the gateway.
     */
    name: string;
    /**
     * Current status of the gateway (e.g. `READY`).
     */
    status: string;
  }
> {}

/**
 * An Amazon Bedrock AgentCore Gateway — a managed MCP endpoint that turns
 * APIs and Lambda functions into agent-callable tools.
 *
 * A gateway fronts one or more targets (OpenAPI specs, Smithy models, Lambda
 * functions) behind a single MCP URL with centralized authorization (SigV4 or
 * JWT).
 *
 * @resource
 * @section Creating Gateways
 * @example IAM-Authorized MCP Gateway
 * ```typescript
 * import * as AgentCore from "alchemy/AWS/BedrockAgentCore";
 * import * as IAM from "alchemy/AWS/IAM";
 *
 * const role = yield* IAM.Role("GatewayRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "bedrock-agentcore.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 * });
 *
 * const gateway = yield* AgentCore.Gateway("ToolGateway", {
 *   roleArn: role.roleArn,
 *   authorizerType: "AWS_IAM",
 * });
 * ```
 *
 * @example JWT-Authorized Gateway
 * ```typescript
 * const gateway = yield* AgentCore.Gateway("JwtGateway", {
 *   roleArn: role.roleArn,
 *   authorizerType: "CUSTOM_JWT",
 *   authorizerConfiguration: {
 *     customJWTAuthorizer: {
 *       discoveryUrl: `https://cognito-idp.us-west-2.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
 *       allowedClients: [client.clientId],
 *     },
 *   },
 * });
 * ```
 */
export const Gateway = Resource<Gateway>("AWS.BedrockAgentCore.Gateway");

/** Statuses indicating an in-flight transition to wait out. */
const GATEWAY_TRANSIENT = new Set(["CREATING", "UPDATING", "DELETING"]);

export const GatewayProvider = () =>
  Provider.effect(
    Gateway,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<GatewayProps, "name">,
      ) {
        return props.name ?? (yield* createGatewayName(id));
      });

      const getGatewayOrUndefined = Effect.fn(function* (
        gatewayIdentifier: string,
      ) {
        return yield* control
          .getGateway({ gatewayIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByName = Effect.fn(function* (name: string) {
        const pages = yield* control.listGateways
          .pages({})
          .pipe(Stream.runCollect);
        const summary = Array.from(pages)
          .flatMap((page) => page.items ?? [])
          .find((s) => s.name === name);
        return summary === undefined
          ? undefined
          : yield* getGatewayOrUndefined(summary.gatewayId);
      });

      const waitForSettled = Effect.fn(function* (gatewayId: string) {
        return yield* getGatewayOrUndefined(gatewayId).pipe(
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (g) => g === undefined || !GATEWAY_TRANSIENT.has(g.status),
            times: 36,
          }),
        );
      });

      const toAttributes = (gateway: control.GetGatewayResponse) => ({
        gatewayId: gateway.gatewayId,
        gatewayArn: gateway.gatewayArn,
        gatewayUrl: gateway.gatewayUrl,
        name: gateway.name,
        status: gateway.status,
      });

      return Gateway.Provider.of({
        stables: ["gatewayId", "gatewayArn", "name"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* control.listGateways
              .pages({})
              .pipe(Stream.runCollect);
            const summaries = Array.from(pages).flatMap(
              (page) => page.items ?? [],
            );
            const hydrated = yield* Effect.forEach(
              summaries,
              (s) => getGatewayOrUndefined(s.gatewayId),
              { concurrency: 5 },
            );
            return hydrated.filter((g) => g !== undefined).map(toAttributes);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const gateway = output?.gatewayId
            ? yield* getGatewayOrUndefined(output.gatewayId)
            : yield* findByName(
                yield* createName(id, olds ?? ({} as GatewayProps)),
              );
          if (gateway === undefined || gateway.status === "DELETING") {
            return undefined;
          }
          const attrs = toAttributes(gateway);
          const tags = yield* readAgentCoreTags(gateway.gatewayArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? ({} as GatewayProps));
          const newName = yield* createName(id, news ?? ({} as GatewayProps));
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            (olds?.kmsKeyArn ?? undefined) !== (news?.kmsKeyArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          // description, role, authorizer, protocol config, and tags converge
          // via update.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? ({} as GatewayProps);
          const name = output?.name ?? (yield* createName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };
          const protocolType = props.protocolType ?? "MCP";
          const authorizerType = props.authorizerType ?? "AWS_IAM";

          // 1. OBSERVE
          let gateway = output?.gatewayId
            ? yield* getGatewayOrUndefined(output.gatewayId)
            : undefined;
          if (gateway === undefined) {
            gateway = yield* findByName(name);
          }

          // 2. ENSURE — a freshly created IAM role is not instantly assumable
          // by the AgentCore service principal, so ride out the transient
          // ValidationException; tolerate the name-exists conflict race.
          if (gateway === undefined) {
            const created = yield* control
              .createGateway({
                name,
                description: props.description,
                roleArn: props.roleArn,
                protocolType,
                protocolConfiguration: props.protocolConfiguration,
                authorizerType,
                authorizerConfiguration: props.authorizerConfiguration,
                kmsKeyArn: props.kmsKeyArn,
                exceptionLevel: props.exceptionLevel,
                tags: desiredTags,
              })
              .pipe(
                retryWhileValidation,
                Effect.catchTag("ConflictException", () => findByName(name)),
              );
            gateway =
              created === undefined
                ? yield* findByName(name)
                : yield* getGatewayOrUndefined(created.gatewayId);
          }
          if (gateway === undefined) {
            return yield* new AgentCoreProvisioningFailed({
              message: `gateway '${name}' was neither created nor found`,
            });
          }

          gateway = (yield* waitForSettled(gateway.gatewayId)) ?? gateway;
          if (gateway.status === "FAILED") {
            return yield* new AgentCoreProvisioningFailed({
              message: `gateway '${name}' failed: ${(gateway.statusReasons ?? []).join("; ")}`,
            });
          }

          // 3. SYNC — converge mutable settings from OBSERVED state.
          const drifted =
            (unredact(gateway.description) ?? undefined) !==
              (props.description ?? unredact(gateway.description)) ||
            gateway.roleArn !== props.roleArn ||
            gateway.authorizerType !== authorizerType ||
            (gateway.protocolType ?? "MCP") !== protocolType ||
            (gateway.exceptionLevel ?? undefined) !==
              (props.exceptionLevel ?? undefined) ||
            JSON.stringify(gateway.authorizerConfiguration ?? null) !==
              JSON.stringify(
                props.authorizerConfiguration ??
                  gateway.authorizerConfiguration ??
                  null,
              ) ||
            (props.protocolConfiguration !== undefined &&
              JSON.stringify(gateway.protocolConfiguration ?? null) !==
                JSON.stringify(props.protocolConfiguration));
          if (drifted) {
            yield* control
              .updateGateway({
                gatewayIdentifier: gateway.gatewayId,
                name,
                description: props.description,
                roleArn: props.roleArn,
                protocolType,
                protocolConfiguration: props.protocolConfiguration,
                authorizerType,
                authorizerConfiguration: props.authorizerConfiguration,
                kmsKeyArn: props.kmsKeyArn,
                exceptionLevel: props.exceptionLevel,
              })
              .pipe(retryWhileConflict);
            gateway = (yield* waitForSettled(gateway.gatewayId)) ?? gateway;
          }

          // 3b. SYNC TAGS against observed cloud tags.
          yield* syncAgentCoreTags(gateway.gatewayArn, desiredTags);

          // 4. RETURN fresh attributes.
          yield* session.note(gateway.gatewayId);
          return toAttributes(gateway);
        }),

        // A gateway with live targets rejects deletion with a
        // ConflictException until they are gone — the engine deletes targets
        // first, but their teardown is eventually consistent.
        delete: Effect.fn(function* ({ output }) {
          yield* control
            .deleteGateway({ gatewayIdentifier: output.gatewayId })
            .pipe(
              retryWhileConflict,
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          yield* control
            .getGateway({ gatewayIdentifier: output.gatewayId })
            .pipe(
              Effect.map((g) => g.status as string),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed("GONE" as string),
              ),
              Effect.repeat({
                schedule: Schedule.fixed("5 seconds"),
                until: (status) => status === "GONE",
                times: 24,
              }),
            );
        }),
      });
    }),
  );
