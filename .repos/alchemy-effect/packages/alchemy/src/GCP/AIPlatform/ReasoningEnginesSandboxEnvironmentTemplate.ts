import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  encodeDisplayName,
  hasOwnershipMarker,
  lastSegment,
  normalizeLocation,
  parentOf,
  ownsDisplayName,
  parseDisplayName,
  parseName,
  listLocations,
} from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type SandboxEnvironmentTemplateDefaultContainerEnvironment =
  aiplatform.GoogleCloudAiplatformV1SandboxEnvironmentTemplateDefaultContainerEnvironment;
export type SandboxEnvironmentTemplateCustomContainerEnvironment =
  aiplatform.GoogleCloudAiplatformV1SandboxEnvironmentTemplateCustomContainerEnvironment;
export type SandboxEnvironmentTemplateEgressControlConfig =
  aiplatform.GoogleCloudAiplatformV1SandboxEnvironmentTemplateEgressControlConfig;

export type ReasoningEnginesSandboxEnvironmentTemplateProps = {
  /**
   * Parent Reasoning Engine. Full name
   * `projects/{project}/locations/{location}/reasoningEngines/{engine}`
   * or the engine id (combined with `location`). Immutable — changing it
   * replaces the template.
   */
  reasoningEngine: string;
  /**
   * Vertex AI location. Used when `reasoningEngine` is a bare id.
   * Immutable. @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Required by Vertex. SandboxEnvironmentTemplate has no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix for `list` / nuke.
   */
  displayName?: string;
  /**
   * Default container environment.
   */
  defaultContainerEnvironment?: SandboxEnvironmentTemplateDefaultContainerEnvironment;
  /**
   * Custom (BYOC) container environment.
   */
  customContainerEnvironment?: SandboxEnvironmentTemplateCustomContainerEnvironment;
  /**
   * Egress control (internet access).
   */
  egressControlConfig?: SandboxEnvironmentTemplateEgressControlConfig;
};

export type ReasoningEnginesSandboxEnvironmentTemplate = Resource<
  "GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplate",
  ReasoningEnginesSandboxEnvironmentTemplateProps,
  {
    /** Full resource name. */
    name: string;
    /** Template id (last path segment). */
    sandboxEnvironmentTemplateId: string;
    /** Parent Reasoning Engine resource name. */
    reasoningEngine: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI sandbox environment template — the blueprint used to
 * create Agent Engine sandbox environments.
 *
 * There is no update API. Changing parent or location replaces the
 * template. Ownership is stamped into the display name.
 *
 * ### Creating a Template
 * **Example:** Default computer-use container
 * ```typescript
 * const template = yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplate(
 *   "Sandbox",
 *   {
 *     reasoningEngine: engine.name,
 *     displayName: "computer-use",
 *     defaultContainerEnvironment: {
 *       defaultContainerCategory: "DEFAULT_CONTAINER_CATEGORY_COMPUTER_USE",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const ReasoningEnginesSandboxEnvironmentTemplate =
  Resource<ReasoningEnginesSandboxEnvironmentTemplate>(
    "GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplate",
  );

export class ReasoningEnginesSandboxEnvironmentTemplateNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplateNotResolved",
)<{
  name: string;
}> {}

export class ReasoningEnginesSandboxEnvironmentTemplateStillExists extends Data.TaggedError(
  "GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplateStillExists",
)<{
  name: string;
}> {}

const engineNameOf = (
  project: string,
  location: string,
  reasoningEngine: string,
) =>
  reasoningEngine.includes("/")
    ? reasoningEngine
    : `${parentOf(project, location)}/reasoningEngines/${reasoningEngine}`;

const toAttrs = (
  template: aiplatform.GoogleCloudAiplatformV1SandboxEnvironmentTemplate,
  project: string,
) => {
  const name = template.name ?? "";
  const parsed = parseName(name, "sandboxEnvironmentTemplates");
  const display = parseDisplayName(template.displayName);
  const parts = name.split("/").filter((part) => part.length > 0);
  const enginesAt = parts.lastIndexOf("reasoningEngines");
  const reasoningEngine =
    enginesAt >= 0
      ? parts.slice(0, enginesAt + 2).join("/")
      : name.replace(/\/sandboxEnvironmentTemplates\/[^/]+$/, "");
  return {
    name,
    sandboxEnvironmentTemplateId: parsed.resourceId,
    reasoningEngine,
    location: parsed.location,
    project: parsed.project || project,
    displayName: display.displayName,
    state: template.state,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates({
          name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("SandboxEnvironmentsNotEnabled", () =>
            Effect.succeed(undefined),
          ),
        );

const listAt = (parent: string) =>
  aiplatform.listProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.sandboxEnvironmentTemplates ?? []),
      ),
      Stream.take(500),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (id: string, parent: string) =>
  Effect.gen(function* () {
    const templates = yield* listAt(parent);
    for (const template of templates) {
      const parsed = parseDisplayName(template.displayName);
      if (yield* ownsDisplayName(id, template.displayName)) {
        return template;
      }
    }
    return undefined;
  });

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((template) =>
      template === undefined
        ? Effect.void
        : Effect.fail(
            new ReasoningEnginesSandboxEnvironmentTemplateStillExists({
              name,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplateStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listEngines = (parent: string) =>
  aiplatform.listProjectsLocationsReasoningEngines
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.reasoningEngines ?? []),
      ),
      Stream.take(200),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ReasoningEnginesSandboxEnvironmentTemplateProvider = () =>
  Provider.succeed(ReasoningEnginesSandboxEnvironmentTemplate, {
    stables: [
      "name",
      "sandboxEnvironmentTemplateId",
      "reasoningEngine",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousParent = lastSegment(
        olds?.reasoningEngine ?? output?.reasoningEngine ?? "",
      );
      const nextParent = lastSegment(news.reasoningEngine);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      if (
        (previousParent.length > 0 && previousParent !== nextParent) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parentRef = olds?.reasoningEngine ?? output?.reasoningEngine;
      // A create interrupted before its parent resolved has nothing to find.
      if (output?.name === undefined && typeof parentRef !== "string") {
        return undefined;
      }
      const parent = engineNameOf(env.project, location, parentRef ?? "");
      const existing =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(id, parent));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDisplayName(existing.displayName);
      return (yield* ownsDisplayName(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listEngines(parentOf(env.project, location)),
        )).flat();
        const templates = yield* Effect.forEach(
          engines,
          (engine) => (engine.name ? listAt(engine.name) : Effect.succeed([])),
          { concurrency: 4 },
        );
        return templates
          .flat()
          .filter((template) => hasOwnershipMarker(template.displayName))
          .map((template) => toAttrs(template, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = engineNameOf(env.project, location, news.reasoningEngine);
      const internal = yield* createInternalLabels(id);
      const displayName = encodeDisplayName(
        internal,
        news.displayName ?? "sandbox-template",
      );

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(id, parent));

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates({
            parent,
            body: compact({
              displayName,
              defaultContainerEnvironment: news.defaultContainerEnvironment,
              customContainerEnvironment: news.customContainerEnvironment,
              egressControlConfig: news.egressControlConfig,
            }),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        const done =
          created !== undefined
            ? yield* waitForOperation(created, { alreadyExistsOk: true })
            : undefined;
        const createdName =
          done !== undefined ? resourceNameFromOperation(done) : undefined;
        current =
          createdName !== undefined
            ? yield* getByName(createdName)
            : yield* findOwned(id, parent);
      }

      if (current === undefined || current.name === undefined) {
        return yield* new ReasoningEnginesSandboxEnvironmentTemplateNotResolved(
          { name: output?.name ?? parent },
        );
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
