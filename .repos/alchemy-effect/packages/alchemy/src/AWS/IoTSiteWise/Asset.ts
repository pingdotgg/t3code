import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, type Tags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { fetchSiteWiseTags, syncSiteWiseTags } from "./internal.ts";

export type AssetState = sitewise.AssetState;

export interface AssetProps {
  /**
   * A unique name for the asset.
   * @default ${app}-${stage}-${id}
   */
  assetName?: string;
  /**
   * The ID of the asset model from which to create the asset.
   * Changing the model replaces the asset.
   */
  assetModelId: string;
  /**
   * A description for the asset.
   */
  assetDescription?: string;
  /**
   * Tags to associate with the asset.
   */
  tags?: Record<string, string>;
}

export interface Asset extends Resource<
  "AWS.IoTSiteWise.Asset",
  AssetProps,
  {
    /**
     * Service-assigned UUID of the asset.
     */
    assetId: string;
    /**
     * ARN of the asset.
     */
    assetArn: string;
    /**
     * The asset's name.
     */
    assetName: string;
    /**
     * The ID of the asset model the asset was created from.
     */
    assetModelId: string;
    /**
     * Current lifecycle state of the asset.
     */
    state: AssetState;
    /**
     * Current tags reported for the asset.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT SiteWise asset — an instance of an asset model representing
 * a physical piece of industrial equipment or a logical grouping.
 *
 * Asset creation and updates are asynchronous (`CREATING`/`UPDATING` →
 * `ACTIVE`); the provider waits for the asset to converge to `ACTIVE`
 * before returning.
 *
 * @resource
 * @section Creating Assets
 * @example Asset from an Asset Model
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const model = yield* AWS.IoTSiteWise.AssetModel("PumpModel", {
 *   assetModelProperties: [
 *     { name: "Temperature", dataType: "DOUBLE", type: { measurement: {} } },
 *   ],
 * });
 *
 * const asset = yield* AWS.IoTSiteWise.Asset("Pump1", {
 *   assetModelId: model.assetModelId,
 *   assetDescription: "Pump #1 on the west line",
 * });
 * ```
 */
export const Asset = Resource<Asset>("AWS.IoTSiteWise.Asset");

const createAssetName = (
  id: string,
  props: { assetName?: string | undefined },
) =>
  props.assetName
    ? Effect.succeed(props.assetName)
    : createPhysicalName({ id, maxLength: 256 });

interface AssetState_ {
  attrs: Asset["Attributes"];
  described: sitewise.DescribeAssetResponse;
}

const readAssetById = Effect.fn(function* (assetId: string) {
  const described = yield* sitewise
    .describeAsset({ assetId, excludeProperties: true })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described || described.assetStatus.state === "DELETING") {
    return undefined;
  }
  const state: AssetState_ = {
    described,
    attrs: {
      assetId: described.assetId,
      assetArn: described.assetArn,
      assetName: described.assetName,
      assetModelId: described.assetModelId,
      state: described.assetStatus.state,
      tags: yield* fetchSiteWiseTags(described.assetArn),
    },
  };
  return state;
});

const findAssetByName = Effect.fn(function* (
  name: string,
  assetModelId: string,
) {
  const summaries = yield* sitewise.listAssets.pages({ assetModelId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.assetSummaries),
    ),
    // The model itself may not exist yet on a greenfield deploy.
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([])),
  );
  const match = summaries.find(
    (summary) => summary.name === name && summary.status.state !== "DELETING",
  );
  if (!match) return undefined;
  return yield* readAssetById(match.id);
});

/**
 * An asset still transitioning toward the awaited state — retried by
 * {@link waitForAssetState}'s bounded schedule.
 */
class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  readonly assetId: string;
  readonly state: string | undefined;
}> {}

/**
 * An asset whose asynchronous provisioning converged to the terminal
 * `FAILED` state.
 */
export class AssetProvisioningFailed extends Data.TaggedError(
  "AssetProvisioningFailed",
)<{
  readonly assetId: string;
  readonly message: string | undefined;
}> {}

// Explicitly-typed retry wrapper — see AssetModel.ts for why inline
// Effect.retry is forbidden in provider lifecycle code.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "AssetNotReady",
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(30)]),
  });

const retryThroughConflictingOperation = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictingOperationException",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(10)]),
  });

const waitForAssetState = (assetId: string, target: "ACTIVE" | "DELETED") =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* sitewise
        .describeAsset({ assetId, excludeProperties: true })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (target === "DELETED") {
        if (described === undefined) return;
        return yield* Effect.fail(
          new AssetNotReady({ assetId, state: described.assetStatus.state }),
        );
      }
      if (described?.assetStatus.state === "ACTIVE") return;
      if (described?.assetStatus.state === "FAILED") {
        return yield* Effect.fail(
          new AssetProvisioningFailed({
            assetId,
            message: described.assetStatus.error?.message,
          }),
        );
      }
      return yield* Effect.fail(
        new AssetNotReady({ assetId, state: described?.assetStatus.state }),
      );
    }),
  );

export const AssetProvider = () =>
  Provider.effect(
    Asset,
    Effect.gen(function* () {
      return {
        stables: ["assetId", "assetArn"],
        list: () =>
          Effect.gen(function* () {
            // ListAssets requires an assetModelId filter — enumerate models
            // first, then each model's assets.
            const models = yield* sitewise.listAssetModels.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.assetModelSummaries),
              ),
            );
            const summaries = yield* Effect.forEach(
              models.map((model) => model.id),
              (assetModelId) =>
                sitewise.listAssets.pages({ assetModelId }).pipe(
                  EffectStream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) => page.assetSummaries),
                  ),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([]),
                  ),
                ),
              { concurrency: 3 },
            );
            const hydrated = yield* Effect.forEach(
              summaries.flat().map((summary) => summary.id),
              (assetId) => readAssetById(assetId),
              { concurrency: 5 },
            );
            return hydrated.flatMap((state) =>
              state === undefined ? [] : [state.attrs],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const state = output?.assetId
            ? yield* readAssetById(output.assetId)
            : olds?.assetModelId
              ? yield* findAssetByName(
                  yield* createAssetName(id, olds),
                  olds.assetModelId,
                )
              : undefined;
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // An asset cannot move to a different model.
          if (olds.assetModelId !== news.assetModelId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("IoT SiteWise Asset requires props"),
            );
          }
          const name = yield* createAssetName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a name lookup so
          // a create whose state failed to persist is adopted.
          let state = output?.assetId
            ? yield* readAssetById(output.assetId)
            : yield* findAssetByName(name, news.assetModelId);

          // Ensure — create if missing, then wait for ACTIVE. A model that
          // just reached ACTIVE can still briefly reject creates with
          // ConflictingOperationException.
          if (state === undefined) {
            const created = yield* retryThroughConflictingOperation(
              sitewise.createAsset({
                assetName: name,
                assetModelId: news.assetModelId,
                assetDescription: news.assetDescription,
                tags: desiredTags,
              }),
            );
            yield* session.note(
              `Creating asset ${name} (${created.assetId})...`,
            );
            yield* waitForAssetState(created.assetId, "ACTIVE");
            state = yield* readAssetById(created.assetId);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created asset ${name}`),
              );
            }
          }

          // Sync — name/description drift via UpdateAsset.
          const described = state.described;
          if (
            name !== described.assetName ||
            (news.assetDescription ?? "") !== (described.assetDescription ?? "")
          ) {
            yield* retryThroughConflictingOperation(
              sitewise.updateAsset({
                assetId: state.attrs.assetId,
                assetName: name,
                assetDescription: news.assetDescription,
              }),
            );
            yield* waitForAssetState(state.attrs.assetId, "ACTIVE");
            yield* session.note(`Updated asset ${name}`);
          }

          // Sync tags — diff against observed cloud tags.
          yield* syncSiteWiseTags(
            state.attrs.assetArn,
            state.attrs.tags,
            desiredTags,
          );

          yield* session.note(state.attrs.assetArn);

          const final = yield* readAssetById(state.attrs.assetId);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled asset ${name}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deleting an asset that is still associated to a parent (or mid
          // transition) raises ConflictingOperationException — retry
          // through the window, then wait until fully gone so the asset
          // model can be deleted after it.
          yield* retryThroughConflictingOperation(
            sitewise
              .deleteAsset({ assetId: output.assetId })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
          yield* waitForAssetState(output.assetId, "DELETED");
        }),
      };
    }),
  );
