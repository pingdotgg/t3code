import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parseOwnership,
  sameJson,
} from "./ownership.ts";

export type IssueModelInputDataConfig = {
  /**
   * Medium of training conversations (`PHONE_CALL` or `CHAT`). Deprecated
   * in favor of `filter`.
   */
  medium?: "MEDIUM_UNSPECIFIED" | "PHONE_CALL" | "CHAT";
  /**
   * Filter reducing conversations used to train the model.
   */
  filter?: string;
};

export type IssueModelProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the model.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Representative name. Issue models have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
  /**
   * Model language (`en-US`, …).
   */
  languageCode?: string;
  /**
   * Model type (`TYPE_V1` or `TYPE_V2`).
   */
  modelType?: "MODEL_TYPE_UNSPECIFIED" | "TYPE_V1" | "TYPE_V2";
  /**
   * Training-data configuration.
   */
  inputDataConfig?: IssueModelInputDataConfig;
};

export type IssueModel = Resource<
  "GCP.ContactCenterInsights.IssueModel",
  IssueModelProps,
  {
    /** Full resource name. */
    name: string;
    /** Issue model id (last path segment). */
    issueModelId: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Model language. */
    languageCode: string | undefined;
    /** Model type. */
    modelType: string | undefined;
    /** Training-data configuration. */
    inputDataConfig: IssueModelInputDataConfig | undefined;
    /** Server-reported model state. */
    state: string | undefined;
    /** Number of issues. */
    issueCount: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center Insights issue model for topic modeling.
 *
 * Issue models have no labels field — Alchemy stamps ownership into the
 * display name. Location is immutable. Display name, language, model type,
 * and input data config update in place. Create and delete are
 * long-running; a deployed model is undeployed before delete.
 *
 * ### Creating an Issue Model
 * **Example:** V2 model over chat transcripts
 * ```typescript
 * const model = yield* GCP.ContactCenterInsights.IssueModel("Topics", {
 *   displayName: "billing-topics",
 *   modelType: "TYPE_V2",
 *   inputDataConfig: { medium: "CHAT" },
 * });
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const IssueModel = Resource<IssueModel>(
  "GCP.ContactCenterInsights.IssueModel",
);

export class IssueModelNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.IssueModelNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  model: cci.GoogleCloudContactcenterinsightsV1IssueModel,
  project: string,
) => {
  const name = model.name ?? "";
  const parsed = parseOwnership(model.displayName);
  return {
    name,
    issueModelId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    languageCode: model.languageCode,
    modelType: model.modelType,
    inputDataConfig: model.inputDataConfig
      ? {
          medium: model.inputDataConfig.medium as
            | IssueModelInputDataConfig["medium"]
            | undefined,
          filter: model.inputDataConfig.filter,
        }
      : undefined,
    state: model.state,
    issueCount: model.issueCount,
    createTime: model.createTime,
    updateTime: model.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsIssueModels({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((model) =>
      model
        ? Effect.succeed(model)
        : Effect.fail(new IssueModelNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ContactCenterInsights.IssueModelNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsIssueModels({ parent }).pipe(
    Effect.map((page) =>
      (page.issueModels ?? [])
        .filter((model) => hasOwnershipMarker(model.displayName))
        .map((model) => toAttrs(model, project)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

const findByDisplayName = (parent: string, displayName: string) =>
  cci.listProjectsLocationsIssueModels({ parent }).pipe(
    Effect.map((page) =>
      (page.issueModels ?? []).find(
        (model) => model.displayName === displayName,
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const IssueModelProvider = () =>
  Provider.succeed(IssueModel, {
    stables: ["name", "issueModelId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location;
      if (
        previousLocation !== undefined &&
        nextLocation !== undefined &&
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing !== undefined) {
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.displayName))
          ? attrs
          : Unowned(attrs);
      }
      const location = olds?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, olds?.displayName);
      const found = yield* findByDisplayName(parent, displayName);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      return (yield* ownedByAlchemy(id, found.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsIssueModels({
            parent,
            body: {
              displayName,
              languageCode: news.languageCode,
              modelType: news.modelType,
              inputDataConfig: news.inputDataConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done) ?? "";
          if (createdName.length > 0) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findByDisplayName(parent, displayName);
        }
      }

      if (current === undefined) {
        return yield* new IssueModelNotResolved({
          name: output?.name ?? `${parent}/issueModels/-`,
        });
      }

      const name = current.name ?? "";
      const displayChanged = (current.displayName ?? "") !== displayName;
      const languageChanged =
        (current.languageCode ?? "") !== (news.languageCode ?? "");
      const typeChanged = (current.modelType ?? "") !== (news.modelType ?? "");
      const inputChanged = !sameJson(
        current.inputDataConfig
          ? {
              medium: current.inputDataConfig.medium,
              filter: current.inputDataConfig.filter,
            }
          : undefined,
        news.inputDataConfig,
      );

      if (displayChanged || languageChanged || typeChanged || inputChanged) {
        current = yield* cci.patchProjectsLocationsIssueModels({
          name,
          updateMask: [
            displayChanged ? "display_name" : undefined,
            languageChanged ? "language_code" : undefined,
            typeChanged ? "model_type" : undefined,
            inputChanged ? "input_data_config" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            displayName,
            languageCode: news.languageCode,
            modelType: news.modelType,
            inputDataConfig: news.inputDataConfig,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      if (existing.state === "DEPLOYED" || existing.state === "DEPLOYING") {
        const undeploy = yield* cci
          .undeployProjectsLocationsIssueModels({
            name: output.name,
            body: { name: output.name },
          })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
          );
        if (undeploy !== undefined) {
          yield* waitForOperation(undeploy, { notFoundOk: true });
        }
      }
      const operation = yield* cci
        .deleteProjectsLocationsIssueModels({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
