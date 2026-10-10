import * as ces from "@distilled.cloud/gcp/ces_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  DEFAULT_OPENAPI_SCHEMA,
  expandApp,
  forEachApp,
  normalizeLocation,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  toolsetKind,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type AppsToolsetProps = {
  /**
   * Parent CES app. Full name
   * `projects/{project}/locations/{location}/apps/{app}` or the app id
   * (combined with `location`). Immutable — changing it replaces the
   * toolset.
   */
  app: string;
  /**
   * Region used when `app` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Toolset id. If omitted, a unique name is generated. Immutable —
   * changing it replaces the toolset.
   */
  toolsetId?: string;
  /**
   * Human-readable name. Must be unique within the app. Alchemy falls
   * back to the generated toolset id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Execution type for tools in the toolset.
   */
  executionType?: string;
  /**
   * Fake-mode configuration.
   */
  toolFakeConfig?: ces.ToolFakeConfig;
  /**
   * OpenAPI toolset. Used when no other toolset variant is set.
   */
  openApiToolset?: ces.OpenApiToolset;
  /** MCP toolset. */
  mcpToolset?: ces.McpToolset;
  /** Integration Connectors toolset. */
  connectorToolset?: ces.ConnectorToolset;
};

export type AppsToolset = Resource<
  "GCP.CES.AppsToolset",
  AppsToolsetProps,
  {
    /** Full resource name `.../apps/{app}/toolsets/{toolset}`. */
    name: string;
    /** Toolset id (last path segment). */
    toolsetId: string;
    /** Parent app resource name. */
    app: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Execution type. */
    executionType: string | undefined;
    /** Fake-mode configuration. */
    toolFakeConfig: ces.ToolFakeConfig | undefined;
    /** OpenAPI toolset. */
    openApiToolset: ces.OpenApiToolset | undefined;
    /** MCP toolset. */
    mcpToolset: ces.McpToolset | undefined;
    /** Connector toolset. */
    connectorToolset: ces.ConnectorToolset | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-assigned etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Customer Engagement Suite toolset — a dynamically managed group of
 * tools defined by OpenAPI, MCP, or Integration Connectors.
 *
 * Toolsets have no labels field, and the description reaches the model,
 * so Alchemy writes no ownership marker: a generated toolset id
 * identifies the toolset, and `read` reports an explicit id it has no
 * state for as unowned. Parent app, location, toolset id, and toolset
 * kind are immutable.
 *
 * ### Creating a Toolset
 * **Example:** OpenAPI ping toolset
 * ```typescript
 * const toolset = yield* GCP.CES.AppsToolset("Ping", {
 *   app: app.name,
 *   displayName: "ping",
 *   openApiToolset: {
 *     openApiSchema: JSON.stringify({
 *       openapi: "3.0.0",
 *       info: { title: "Ping", version: "1.0.0" },
 *       paths: {
 *         "/ping": {
 *           get: {
 *             operationId: "ping",
 *             responses: { "200": { description: "ok" } },
 *           },
 *         },
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const AppsToolset = Resource<AppsToolset>("GCP.CES.AppsToolset");

export class AppsToolsetNotResolved extends Data.TaggedError(
  "GCP.CES.AppsToolsetNotResolved",
)<{
  name: string;
}> {}

const resourceName = (app: string, toolsetId: string) =>
  `${app}/toolsets/${toolsetId}`;

const openApiOf = (news: AppsToolsetProps): ces.OpenApiToolset | undefined => {
  if (news.mcpToolset || news.connectorToolset) return news.openApiToolset;
  return (
    news.openApiToolset ?? {
      openApiSchema: DEFAULT_OPENAPI_SCHEMA,
    }
  );
};

const toAttrs = (
  toolset: ces.Toolset,
  project: string,
  region: string,
  appHint?: string,
) => {
  const name = toolset.name ?? "";
  const parsed = parseResourceName(name, "toolsets", region);
  return {
    name,
    toolsetId: parsed.id,
    app: name.includes("/toolsets/") ? parsed.app : (appHint ?? parsed.parent),
    location: parsed.location,
    project: parsed.project || project,
    displayName: toolset.displayName,
    description: parseOwnership(toolset.description).text,
    executionType: toolset.executionType,
    toolFakeConfig: toolset.toolFakeConfig,
    openApiToolset: toolset.openApiToolset,
    mcpToolset: toolset.mcpToolset,
    connectorToolset: toolset.connectorToolset,
    createTime: toolset.createTime,
    updateTime: toolset.updateTime,
    etag: toolset.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsAppsToolsets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  collectPages(
    ces.listProjectsLocationsAppsToolsets.pages({ parent, pageSize: 100 }),
    (page) => page.toolsets,
  ).pipe(
    Effect.map((toolsets) =>
      toolsets.map((toolset) => toAttrs(toolset, project, region, parent)),
    ),
  );

export const AppsToolsetProvider = () =>
  Provider.succeed(AppsToolset, {
    stables: ["name", "toolsetId", "app", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousKind = toolsetKind(olds ?? output ?? {});
      const nextKind = toolsetKind(news);
      return replaceOnIdentity({
        previousId: olds?.toolsetId ?? output?.toolsetId,
        nextId: news.toolsetId,
        previousParent: olds?.app ?? output?.app,
        nextParent: news.app,
        extra: previousKind !== nextKind && previousKind !== "openApiToolset",
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const app = olds?.app
        ? expandApp(olds.app, env.project, location)
        : output?.app;
      const toolsetId = yield* toPhysicalId(
        id,
        olds?.toolsetId,
        output?.toolsetId,
      );
      const name =
        output?.name ?? (app !== undefined ? resourceName(app, toolsetId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, app);
      return output !== undefined || olds?.toolsetId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* forEachApp(
          env.project,
          (parent) => listAt(parent, env.project, env.region),
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const app = expandApp(news.app, env.project, location);
      const toolsetId = yield* toPhysicalId(
        id,
        news.toolsetId,
        output?.toolsetId,
      );
      const name = output?.name ?? resourceName(app, toolsetId);
      const description = news.description;
      const displayName = news.displayName ?? toolsetId;
      const openApiToolset = openApiOf(news);
      const kind = toolsetKind({
        openApiToolset,
        mcpToolset: news.mcpToolset,
        connectorToolset: news.connectorToolset,
      });

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsAppsToolsets({
            parent: app,
            toolsetId,
            body: {
              displayName,
              description,
              executionType: news.executionType,
              toolFakeConfig: news.toolFakeConfig,
              openApiToolset,
              mcpToolset: news.mcpToolset,
              connectorToolset: news.connectorToolset,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsToolsetNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const executionChanged = !sameText(
        current.executionType,
        news.executionType,
      );
      const fakeChanged = !sameJson(
        current.toolFakeConfig,
        news.toolFakeConfig,
      );
      const variantChanged =
        kind === "openApiToolset"
          ? !sameJson(current.openApiToolset, openApiToolset)
          : kind === "mcpToolset"
            ? !sameJson(current.mcpToolset, news.mcpToolset)
            : !sameJson(current.connectorToolset, news.connectorToolset);

      if (
        displayChanged ||
        descriptionChanged ||
        executionChanged ||
        fakeChanged ||
        variantChanged
      ) {
        current = yield* retryTransient(
          ces.patchProjectsLocationsAppsToolsets({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              executionChanged ? "execution_type" : undefined,
              fakeChanged ? "tool_fake_config" : undefined,
              variantChanged
                ? kind === "openApiToolset"
                  ? "open_api_toolset"
                  : kind === "mcpToolset"
                    ? "mcp_toolset"
                    : "connector_toolset"
                : undefined,
            ),
            body: {
              displayName,
              description,
              executionType: news.executionType,
              toolFakeConfig: news.toolFakeConfig,
              openApiToolset,
              mcpToolset: news.mcpToolset,
              connectorToolset: news.connectorToolset,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        ces.deleteProjectsLocationsAppsToolsets({
          name: output.name,
          force: true,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
