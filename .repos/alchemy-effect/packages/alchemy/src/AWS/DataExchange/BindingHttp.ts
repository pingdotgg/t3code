import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Output as OutputType } from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DataSet } from "./DataSet.ts";
import type { Revision } from "./Revision.ts";

/**
 * Shared scaffolding for AWS Data Exchange HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation, the IAM action list, and
 * the granted ARNs is boilerplate: the runtime callable injects `DataSetId`
 * (and `RevisionId` for revision-scoped operations) from the bound resource.
 */

/** The bound data set's own ARN (data-set-level actions). */
export const dataSetArns = (dataSet: DataSet): OutputType<string>[] => [
  dataSet.dataSetArn,
];

/**
 * ARN matching every asset in the bound data set
 * (`arn:…:data-sets/{id}/revisions/star/assets/star`) — asset-level actions
 * like `dataexchange:SendApiAsset` authorize against the asset resource.
 */
export const dataSetAssetArns = (dataSet: DataSet): OutputType<string>[] => [
  dataSet.dataSetArn.pipe(Output.map((arn) => `${arn}/revisions/*/assets/*`)),
];

/**
 * The bound data set's ARN plus a wildcard over every sub-resource
 * (`arn:…:data-sets/{id}` and `arn:…:data-sets/{id}/star`) — IAM wildcards
 * match across `/`, so one pattern covers revisions and assets alike. Used
 * by the revision/asset data-plane bindings that receive `RevisionId` and
 * `AssetId` at runtime (e.g. a Lambda that publishes a fresh revision on a
 * schedule needs the grant to cover revisions that do not exist yet).
 */
export const dataSetAndSubresourceArns = (
  dataSet: DataSet,
): OutputType<string>[] => [
  dataSet.dataSetArn,
  Output.interpolate`${dataSet.dataSetArn}/*`,
];

/** The bound revision's own ARN (revision-level actions). */
export const revisionArns = (revision: Revision): OutputType<string>[] => [
  revision.revisionArn,
];

/**
 * ARN matching every asset in the bound revision
 * (`arn:…:data-sets/{ds}/revisions/{rev}/assets/star`) — asset-level
 * actions like `dataexchange:GetAsset` authorize against the asset resource.
 */
export const revisionAssetArns = (revision: Revision): OutputType<string>[] => [
  revision.revisionArn.pipe(Output.map((arn) => `${arn}/assets/*`)),
];

/**
 * Build the impl Effect for a Data Exchange operation scoped to a
 * {@link DataSet}: the deploy-time half grants `actions` on `resources`
 * (default: the data set's ARN), and the runtime half injects the data set's
 * `DataSetId` into every request.
 */
export const makeDataSetHttpBinding = <
  I extends { DataSetId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DataExchange.GetDataSet`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the data set ARN */
  resources?: (dataSet: DataSet) => OutputType<string>[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (dataSet: DataSet) {
      const DataSetId = yield* dataSet.dataSetId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${dataSet}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: (options.resources ?? dataSetArns)(dataSet),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dataSet.LogicalId})`)(function* (
        request?: Omit<I, "DataSetId">,
      ) {
        const dataSetId = yield* DataSetId;
        return yield* op({ ...request, DataSetId: dataSetId } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Data Exchange operation scoped to a
 * {@link Revision}: the deploy-time half grants `actions` on `resources`
 * (default: the revision's ARN), and the runtime half injects the revision's
 * `DataSetId` and `RevisionId` into every request.
 */
export const makeRevisionHttpBinding = <
  I extends { DataSetId: string; RevisionId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DataExchange.GetRevision`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the revision ARN */
  resources?: (revision: Revision) => OutputType<string>[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (revision: Revision) {
      const DataSetId = yield* revision.dataSetId;
      const RevisionId = yield* revision.revisionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${revision}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: (options.resources ?? revisionArns)(revision),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${revision.LogicalId})`)(function* (
        request?: Omit<I, "DataSetId" | "RevisionId">,
      ) {
        const dataSetId = yield* DataSetId;
        const revisionId = yield* RevisionId;
        return yield* op({
          ...request,
          DataSetId: dataSetId,
          RevisionId: revisionId,
        } as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Data Exchange operation (jobs,
 * data grants, enumerations). The deploy-time half grants `actions` on `*`
 * — jobs and data grants are account-scoped resources whose ids only exist
 * at runtime, so there is no resource ARN to scope down to.
 */
export const makeDataExchangeAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DataExchange.ListDataSets`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
