import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Application } from "./Application.ts";
import type { DataSource } from "./DataSource.ts";
import type { Index } from "./SearchIndex.ts";
import type { WebExperience } from "./WebExperience.ts";

/**
 * Shared scaffolding for AWS QBusiness HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the four
 * builders below. Everything except the operation and the IAM action list
 * is boilerplate: every Amazon Q Business operation is scoped to one
 * application (whose id is injected as `applicationId`), and the
 * index/data-source/web-experience operations additionally inject their
 * sub-resource ids and receive grants on the sub-resource ARN plus its
 * parents (Q Business authorizes most actions against both the application
 * and the sub-resource).
 */

/**
 * Build the impl Effect for an application-scoped Q Business operation
 * (chat, conversations, users, subscriptions, chat controls, policy): the
 * runtime callable injects the bound {@link Application}'s id as
 * `applicationId` and the deploy-time half grants `actions` on the
 * application ARN (plus any `subResources` suffix patterns, e.g.
 * `retriever/*` for `SearchRelevantContent`, which Q Business additionally
 * authorizes against the retriever it searches).
 */
export const makeQBusinessApplicationHttpBinding = <
  I extends { applicationId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.QBusiness.ChatSync`. */
  tag: string;
  /** The distilled operation; `applicationId` is injected from the application. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the application ARN. */
  actions: readonly string[];
  /**
   * Extra ARN suffix patterns (relative to the application ARN) the
   * actions are also granted on, e.g. `retriever/*`.
   */
  subResources?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (application: Application) {
      const applicationId = yield* application.applicationId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${application}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  application.applicationArn,
                  ...(options.subResources ?? []).map(
                    (suffix) =>
                      Output.interpolate`${application.applicationArn}/${suffix}`,
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${application.LogicalId})`)(function* (
        request?: Omit<I, "applicationId">,
      ) {
        return yield* op({
          ...request,
          applicationId: yield* applicationId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an index-scoped Q Business operation (document
 * batches, groups, document reads): the runtime callable injects the bound
 * {@link Index}'s `applicationId` + `indexId` and the deploy-time half
 * grants `actions` on the index ARN **and** its parent application ARN —
 * Q Business authorizes index actions against both.
 */
export const makeQBusinessIndexHttpBinding = <
  I extends { applicationId: string; indexId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.QBusiness.BatchPutDocument`. */
  tag: string;
  /**
   * The distilled operation; `applicationId` and `indexId` are injected
   * from the index.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the index ARN + its parent application ARN. */
  actions: readonly string[];
  /**
   * Extra ARN suffix patterns (relative to the index ARN) the actions are
   * also granted on, e.g. `data-source/*` for the principal-group
   * operations that also act on data-source-scoped groups.
   */
  subResources?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (index: Index) {
      const applicationId = yield* index.applicationId;
      const indexId = yield* index.indexId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${index}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  index.indexArn,
                  // The index ARN is `…:application/{appId}/index/{indexId}`
                  // — the parent application ARN is its prefix.
                  index.indexArn.pipe(
                    Output.map((arn) => arn.split("/index/")[0]!),
                  ),
                  ...(options.subResources ?? []).map(
                    (suffix) => Output.interpolate`${index.indexArn}/${suffix}`,
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${index.LogicalId})`)(function* (
        request?: Omit<I, "applicationId" | "indexId">,
      ) {
        return yield* op({
          ...request,
          applicationId: yield* applicationId,
          indexId: yield* indexId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a data-source-scoped Q Business operation (the
 * sync job start/stop/list trio): the runtime callable injects the bound
 * {@link DataSource}'s `applicationId` + `indexId` + `dataSourceId`; the
 * deploy-time half grants `actions` on the data source ARN **and** its
 * parent index + application ARNs.
 */
export const makeQBusinessDataSourceHttpBinding = <
  I extends { applicationId: string; indexId: string; dataSourceId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.QBusiness.StartDataSourceSyncJob`. */
  tag: string;
  /**
   * The distilled operation; `applicationId`, `indexId`, and
   * `dataSourceId` are injected from the data source.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /**
   * IAM actions granted on the data source ARN + its parent index and
   * application ARNs.
   */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (dataSource: DataSource) {
      const applicationId = yield* dataSource.applicationId;
      const indexId = yield* dataSource.indexId;
      const dataSourceId = yield* dataSource.dataSourceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${dataSource}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  dataSource.dataSourceArn,
                  // The data source ARN is
                  // `…:application/{appId}/index/{indexId}/data-source/{dsId}`
                  // — the parent index and application ARNs are prefixes.
                  dataSource.dataSourceArn.pipe(
                    Output.map((arn) => arn.split("/data-source/")[0]!),
                  ),
                  dataSource.dataSourceArn.pipe(
                    Output.map((arn) => arn.split("/index/")[0]!),
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dataSource.LogicalId})`)(function* (
        request?: Omit<I, "applicationId" | "indexId" | "dataSourceId">,
      ) {
        return yield* op({
          ...request,
          applicationId: yield* applicationId,
          indexId: yield* indexId,
          dataSourceId: yield* dataSourceId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a web-experience-scoped Q Business operation
 * (anonymous URL minting): the runtime callable injects the bound
 * {@link WebExperience}'s `applicationId` + `webExperienceId`; the
 * deploy-time half grants `actions` on the web experience ARN **and** its
 * parent application ARN.
 */
export const makeQBusinessWebExperienceHttpBinding = <
  I extends { applicationId: string; webExperienceId: string },
  A,
  E,
  R,
  Req = Omit<I, "applicationId" | "webExperienceId">,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.QBusiness.CreateAnonymousWebExperienceUrl`. */
  tag: string;
  /**
   * The distilled operation; `applicationId` and `webExperienceId` are
   * injected from the web experience.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /**
   * IAM actions granted on the web experience ARN + its parent application
   * ARN.
   */
  actions: readonly string[];
  /**
   * Map the public request shape to the wire request (defaults to
   * identity) — e.g. `CreateAnonymousWebExperienceUrl` converts a
   * `Duration.Input` into the wire `sessionDurationInMinutes`.
   */
  prepare?: (
    request: Req | undefined,
  ) => Omit<I, "applicationId" | "webExperienceId">;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (webExperience: WebExperience) {
      const applicationId = yield* webExperience.applicationId;
      const webExperienceId = yield* webExperience.webExperienceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${webExperience}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  webExperience.webExperienceArn,
                  // The web experience ARN is
                  // `…:application/{appId}/web-experience/{weId}` — the
                  // parent application ARN is its prefix.
                  webExperience.webExperienceArn.pipe(
                    Output.map((arn) => arn.split("/web-experience/")[0]!),
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${webExperience.LogicalId})`)(function* (
        request?: Req,
      ) {
        const wire = options.prepare
          ? options.prepare(request)
          : (request as unknown as
              | Omit<I, "applicationId" | "webExperienceId">
              | undefined);
        return yield* op({
          ...wire,
          applicationId: yield* applicationId,
          webExperienceId: yield* webExperienceId,
        } as I);
      });
    });
  });
