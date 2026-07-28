import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { AgentAlias } from "./AgentAlias.ts";
import type { DataSource } from "./DataSource.ts";
import type { KnowledgeBase } from "./KnowledgeBase.ts";
import { bedrockModelArns } from "./ModelArns.ts";

/**
 * Shared scaffolding for Bedrock HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action list, and the
 * injected identifier(s) is boilerplate. Genuinely-different bindings
 * (e.g. `Rerank`, which grants a wildcard `bedrock:Rerank` alongside
 * model-scoped `bedrock:InvokeModel`) stay bespoke.
 */

const currentEnv = AWSEnvironment.current as unknown as Effect.Effect<{
  accountId: string;
  region: string;
}>;

/**
 * Build the impl Effect for a model-scoped `bedrock-runtime` operation whose
 * request carries a top-level `modelId`. The binding accepts one or more
 * model references (foundation-model id, cross-region inference profile id,
 * or full ARN), grants `actions` on exactly the resolved model ARNs, and the
 * runtime callable defaults `modelId` to the first bound model.
 */
export const makeModelScopedHttpBinding = <
  I extends { modelId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Bedrock.Converse`. */
  tag: string;
  /** The distilled operation; `modelId` defaults to the first bound model. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the bound model ARNs. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (model: string, ...additionalModels: string[]) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } = yield* currentEnv;
          // Sort so the binding identity (SID + ARN list) is deterministic
          // regardless of argument order.
          const sorted = [...new Set([model, ...additionalModels])].sort();
          yield* host.bind`Allow(${host}, ${options.tag}(${sorted.join(",")}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [
                    ...new Set(
                      sorted.flatMap((id) =>
                        bedrockModelArns(region, accountId, id),
                      ),
                    ),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${model})`)(function* (
        request: Omit<I, "modelId"> & { modelId?: string },
      ) {
        return yield* op({
          ...request,
          modelId: request.modelId ?? model,
        } as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for a knowledge-base-scoped `bedrock-agent-runtime`
 * operation whose request carries a top-level `knowledgeBaseId`. The binding
 * grants `actions` on the bound {@link KnowledgeBase}'s ARN and the runtime
 * callable injects its `knowledgeBaseId`.
 */
export const makeKnowledgeBaseScopedHttpBinding = <
  I extends { knowledgeBaseId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Bedrock.Retrieve`. */
  tag: string;
  /** The distilled operation; `knowledgeBaseId` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the knowledge-base ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <K extends KnowledgeBase>(knowledgeBase: K) {
      const KnowledgeBaseId = yield* knowledgeBase.knowledgeBaseId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${knowledgeBase}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [knowledgeBase.knowledgeBaseArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${knowledgeBase.LogicalId})`)(function* (
        request: Omit<I, "knowledgeBaseId">,
      ) {
        return yield* op({
          ...request,
          knowledgeBaseId: yield* KnowledgeBaseId,
        } as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for a data-source-scoped `bedrock-agent` operation
 * whose request carries top-level `knowledgeBaseId` + `dataSourceId`
 * (ingestion jobs, direct document ingestion). Bedrock authorizes these
 * actions against the parent knowledge-base ARN, so the deploy-time half
 * grants `actions` on the bound {@link DataSource}'s knowledge base; the
 * runtime callable injects both identifiers.
 */
export const makeDataSourceScopedHttpBinding = <
  I extends { knowledgeBaseId: string; dataSourceId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Bedrock.StartIngestionJob`. */
  tag: string;
  /** The distilled operation; both identifiers are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the parent knowledge-base ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <D extends DataSource>(dataSource: D) {
      const KnowledgeBaseId = yield* dataSource.knowledgeBaseId;
      const DataSourceId = yield* dataSource.dataSourceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } = yield* currentEnv;
          yield* host.bind`Allow(${host}, ${options.tag}(${dataSource}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  dataSource.knowledgeBaseId.pipe(
                    Output.map(
                      (id) =>
                        `arn:aws:bedrock:${region}:${accountId}:knowledge-base/${id}`,
                    ),
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dataSource.LogicalId})`)(function* (
        request: Omit<I, "knowledgeBaseId" | "dataSourceId">,
      ) {
        return yield* op({
          ...request,
          knowledgeBaseId: yield* KnowledgeBaseId,
          dataSourceId: yield* DataSourceId,
        } as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for an agent-alias-scoped `bedrock-agent-runtime`
 * operation whose request carries top-level `agentId` + `agentAliasId`. The
 * binding grants `actions` on the bound {@link AgentAlias}'s ARN and the
 * runtime callable injects both identifiers.
 */
export const makeAgentAliasScopedHttpBinding = <
  I extends { agentId: string; agentAliasId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Bedrock.InvokeAgent`. */
  tag: string;
  /** The distilled operation; both identifiers are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the agent-alias ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <AA extends AgentAlias>(alias: AA) {
      const AgentId = yield* alias.agentId;
      const AgentAliasId = yield* alias.agentAliasId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${alias}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [alias.agentAliasArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${alias.LogicalId})`)(function* (
        request: Omit<I, "agentId" | "agentAliasId">,
      ) {
        return yield* op({
          ...request,
          agentId: yield* AgentId,
          agentAliasId: yield* AgentAliasId,
        } as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for a managed-RAG operation (`RetrieveAndGenerate` /
 * `RetrieveAndGenerateStream`). The binding grants `bedrock:Retrieve` +
 * `bedrock:RetrieveAndGenerate` on the bound {@link KnowledgeBase} plus
 * `bedrock:InvokeModel` scoped to the named generation models (or all
 * foundation models + cross-region inference profiles when none are named).
 * The request passes through unchanged — the knowledge base is referenced
 * inside `retrieveAndGenerateConfiguration`.
 */
export const makeRagHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Bedrock.RetrieveAndGenerate`. */
  tag: string;
  /** The distilled operation; the request passes through unchanged. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <K extends KnowledgeBase>(
      knowledgeBase: K,
      ...models: string[]
    ) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } = yield* currentEnv;
          // Scope InvokeModel to the named models, or all foundation models +
          // cross-region inference profiles when the caller names none.
          const modelResources =
            models.length > 0
              ? [
                  ...new Set(
                    models.flatMap((id) =>
                      bedrockModelArns(region, accountId, id),
                    ),
                  ),
                ]
              : [
                  `arn:aws:bedrock:${region}::foundation-model/*`,
                  `arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
                ];
          yield* host.bind`Allow(${host}, ${options.tag}(${knowledgeBase}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"],
                Resource: [knowledgeBase.knowledgeBaseArn],
              },
              {
                Effect: "Allow",
                Action: ["bedrock:InvokeModel"],
                Resource: modelResources,
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${knowledgeBase.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
