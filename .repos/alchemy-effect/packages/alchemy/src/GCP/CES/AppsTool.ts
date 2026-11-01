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
  expandApp,
  forEachApp,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  toolKind,
  unstampToolDescription,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type AppsToolProps = {
  /**
   * Parent CES app. Full name
   * `projects/{project}/locations/{location}/apps/{app}` or the app id
   * (combined with `location`). Immutable — changing it replaces the
   * tool.
   */
  app: string;
  /**
   * Region used when `app` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Tool id. If omitted, a unique name is generated. Immutable —
   * changing it replaces the tool.
   */
  toolId?: string;
  /**
   * Execution type (`SYNCHRONOUS`, `ASYNCHRONOUS`).
   */
  executionType?: string;
  /**
   * Tool timeout (e.g. `"30s"`).
   */
  timeout?: string;
  /**
   * Fake-mode configuration.
   */
  toolFakeConfig?: ces.ToolFakeConfig;
  /**
   * Client-side function. Used when no other tool variant is set.
   */
  clientFunction?: ces.ClientFunction;
  /** Python function tool. */
  pythonFunction?: ces.PythonFunction;
  /** Google Search grounding tool. */
  googleSearchTool?: ces.GoogleSearchTool;
  /** OpenAPI tool. */
  openApiTool?: ces.OpenApiTool;
  /** Widget tool. */
  widgetTool?: ces.WidgetTool;
  /** File-search tool. */
  fileSearchTool?: ces.FileSearchTool;
  /** Vertex AI Search data-store tool. */
  dataStoreTool?: ces.DataStoreTool;
  /** Nested-agent tool. */
  agentTool?: ces.AgentTool;
  /** Remote A2A agent tool. */
  remoteAgentTool?: ces.RemoteAgentTool;
  /** Integration Connectors tool. */
  connectorTool?: ces.ConnectorTool;
  /** Built-in system tool. */
  systemTool?: ces.SystemTool;
};

export type AppsTool = Resource<
  "GCP.CES.AppsTool",
  AppsToolProps,
  {
    /** Full resource name `.../apps/{app}/tools/{tool}`. */
    name: string;
    /** Tool id (last path segment). */
    toolId: string;
    /** Parent app resource name. */
    app: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Server-derived display name. */
    displayName: string | undefined;
    /** Execution type. */
    executionType: string | undefined;
    /** Timeout. */
    timeout: string | undefined;
    /** Fake-mode configuration. */
    toolFakeConfig: ces.ToolFakeConfig | undefined;
    /** Client function (ownership prefix stripped from description). */
    clientFunction: ces.ClientFunction | undefined;
    /** Python function. */
    pythonFunction: ces.PythonFunction | undefined;
    /** Google Search tool. */
    googleSearchTool: ces.GoogleSearchTool | undefined;
    /** OpenAPI tool. */
    openApiTool: ces.OpenApiTool | undefined;
    /** Widget tool. */
    widgetTool: ces.WidgetTool | undefined;
    /** File-search tool. */
    fileSearchTool: ces.FileSearchTool | undefined;
    /** Data-store tool. */
    dataStoreTool: ces.DataStoreTool | undefined;
    /** Nested-agent tool. */
    agentTool: ces.AgentTool | undefined;
    /** Remote agent tool. */
    remoteAgentTool: ces.RemoteAgentTool | undefined;
    /** Connector tool. */
    connectorTool: ces.ConnectorTool | undefined;
    /** System tool. */
    systemTool: ces.SystemTool | undefined;
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
 * A Customer Engagement Suite tool inside an app (client function,
 * Python, OpenAPI, Google Search, widget, and related variants).
 *
 * Tools have no labels field, and a tool's description tells the model
 * when to call it, so Alchemy writes no ownership marker: a generated
 * tool id identifies the tool, and `read` reports an explicit id it has no
 * state for as unowned. Parent app, location, tool id, and tool kind are
 * immutable.
 *
 * ### Creating a Tool
 * **Example:** Client function
 * ```typescript
 * const tool = yield* GCP.CES.AppsTool("Lookup", {
 *   app: app.name,
 *   clientFunction: {
 *     name: "lookup_order",
 *     description: "Look up an order by id.",
 *     parameters: {
 *       type: "OBJECT",
 *       properties: { orderId: { type: "STRING" } },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const AppsTool = Resource<AppsTool>("GCP.CES.AppsTool");

export class AppsToolNotResolved extends Data.TaggedError(
  "GCP.CES.AppsToolNotResolved",
)<{
  name: string;
}> {}

const resourceName = (app: string, toolId: string) => `${app}/tools/${toolId}`;

const variantOf = (tool: ces.Tool, kind: ReturnType<typeof toolKind>) => {
  switch (kind) {
    case "fileSearchTool":
      return tool.fileSearchTool;
    case "pythonFunction":
      return tool.pythonFunction;
    case "googleSearchTool":
      return tool.googleSearchTool;
    case "mcpTool":
      return tool.mcpTool;
    case "remoteAgentTool":
      return tool.remoteAgentTool;
    case "widgetTool":
      return tool.widgetTool;
    case "systemTool":
      return tool.systemTool;
    case "openApiTool":
      return tool.openApiTool;
    case "connectorTool":
      return tool.connectorTool;
    case "dataStoreTool":
      return tool.dataStoreTool;
    case "agentTool":
      return tool.agentTool;
    default:
      return tool.clientFunction;
  }
};

const toBody = (news: AppsToolProps): ces.Tool => ({
  executionType: news.executionType,
  timeout: news.timeout,
  toolFakeConfig: news.toolFakeConfig,
  clientFunction: news.clientFunction,
  pythonFunction: news.pythonFunction,
  googleSearchTool: news.googleSearchTool,
  openApiTool: news.openApiTool,
  widgetTool: news.widgetTool,
  fileSearchTool: news.fileSearchTool,
  dataStoreTool: news.dataStoreTool,
  agentTool: news.agentTool,
  remoteAgentTool: news.remoteAgentTool,
  connectorTool: news.connectorTool,
  systemTool: news.systemTool,
});

const toAttrs = (
  tool: ces.Tool,
  project: string,
  region: string,
  appHint?: string,
) => {
  const name = tool.name ?? "";
  const parsed = parseResourceName(name, "tools", region);
  const unstamped = unstampToolDescription(tool);
  return {
    name,
    toolId: parsed.id,
    app: name.includes("/tools/") ? parsed.app : (appHint ?? parsed.parent),
    location: parsed.location,
    project: parsed.project || project,
    displayName: tool.displayName,
    executionType: tool.executionType,
    timeout: tool.timeout,
    toolFakeConfig: tool.toolFakeConfig,
    clientFunction: unstamped.clientFunction,
    pythonFunction: unstamped.pythonFunction,
    googleSearchTool: unstamped.googleSearchTool,
    openApiTool: unstamped.openApiTool,
    widgetTool: unstamped.widgetTool,
    fileSearchTool: unstamped.fileSearchTool,
    dataStoreTool: unstamped.dataStoreTool,
    agentTool: unstamped.agentTool,
    remoteAgentTool: unstamped.remoteAgentTool,
    connectorTool: unstamped.connectorTool,
    systemTool: unstamped.systemTool,
    createTime: tool.createTime,
    updateTime: tool.updateTime,
    etag: tool.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsAppsTools({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  collectPages(
    ces.listProjectsLocationsAppsTools.pages({ parent, pageSize: 100 }),
    (page) => page.tools,
  ).pipe(
    Effect.map((tools) =>
      tools.map((tool) => toAttrs(tool, project, region, parent)),
    ),
  );

export const AppsToolProvider = () =>
  Provider.succeed(AppsTool, {
    stables: ["name", "toolId", "app", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousKind = toolKind(olds ?? output ?? {});
      const nextKind = toolKind(news);
      return replaceOnIdentity({
        previousId: olds?.toolId ?? output?.toolId,
        nextId: news.toolId,
        previousParent: olds?.app ?? output?.app,
        nextParent: news.app,
        extra: previousKind !== nextKind && previousKind !== "clientFunction",
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
      const toolId = yield* toPhysicalId(id, olds?.toolId, output?.toolId);
      const name =
        output?.name ?? (app !== undefined ? resourceName(app, toolId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, app);
      return output !== undefined || olds?.toolId === undefined
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
      const toolId = yield* toPhysicalId(id, news.toolId, output?.toolId);
      const name = output?.name ?? resourceName(app, toolId);
      const body = toBody(news);
      const kind = toolKind(body);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsAppsTools({
            parent: app,
            toolId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsToolNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const executionChanged = !sameText(
        current.executionType,
        body.executionType,
      );
      const timeoutChanged = !sameText(current.timeout, body.timeout);
      const fakeChanged = !sameJson(
        current.toolFakeConfig,
        body.toolFakeConfig,
      );
      const variantChanged = !sameJson(
        variantOf(current, kind),
        variantOf(body, kind),
      );

      if (executionChanged || timeoutChanged || fakeChanged || variantChanged) {
        current = yield* retryTransient(
          ces.patchProjectsLocationsAppsTools({
            name: currentName,
            updateMask: updateMaskOf(
              executionChanged ? "execution_type" : undefined,
              timeoutChanged ? "timeout" : undefined,
              fakeChanged ? "tool_fake_config" : undefined,
              variantChanged
                ? kind === "clientFunction"
                  ? "client_function"
                  : kind === "pythonFunction"
                    ? "python_function"
                    : kind === "googleSearchTool"
                      ? "google_search_tool"
                      : kind === "openApiTool"
                        ? "open_api_tool"
                        : kind === "widgetTool"
                          ? "widget_tool"
                          : kind === "fileSearchTool"
                            ? "file_search_tool"
                            : kind === "dataStoreTool"
                              ? "data_store_tool"
                              : kind === "agentTool"
                                ? "agent_tool"
                                : kind === "remoteAgentTool"
                                  ? "remote_agent_tool"
                                  : kind === "connectorTool"
                                    ? "connector_tool"
                                    : kind === "systemTool"
                                      ? "system_tool"
                                      : "mcp_tool"
                : undefined,
            ),
            body,
          }),
        );
      }

      return toAttrs(current, env.project, env.region, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        ces.deleteProjectsLocationsAppsTools({
          name: output.name,
          force: true,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
