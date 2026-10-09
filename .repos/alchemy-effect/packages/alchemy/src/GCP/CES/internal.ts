import * as ces from "@distilled.cloud/gcp/ces_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

// CES resource ids must match `[a-zA-Z0-9][a-zA-Z0-9-_]{4,35}`.
export const MAX_ID_LENGTH = 36;
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 8000;

export class CesPending extends Data.TaggedError("GCP.CES.Pending")<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parseResourceName = (
  name: string,
  collection: string,
  fallbackLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const appsAt = parts.lastIndexOf("apps");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    appId: appsAt >= 0 && parts[appsAt + 1] ? parts[appsAt + 1]! : "",
    app: appsAt >= 0 ? parts.slice(0, appsAt + 2).join("/") : parentOf(name),
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandApp = (value: string, project: string, location: string) =>
  value.includes("/apps/")
    ? value.replace(/\/+$/, "")
    : `${locationParent(project, location)}/apps/${value}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `c${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

export const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(metadata));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const compactMarkerOf = (stack: string, stage: string, id: string) =>
  `[alc ${stack} ${stage} ${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = shrinkMarker(
    labels,
    MAX_DESCRIPTION_LENGTH,
    (stack, stage, id) => markerOf(labels, stack, stage, id),
  );
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  // Shrink the marker, not the user text, so the display name round-trips.
  const budget = trimmed
    ? Math.max(maxLength - trimmed.length - 1, 16)
    : maxLength;
  const marker =
    budget < 54
      ? shrinkMarker(labels, budget, compactMarkerOf)
      : shrinkMarker(labels, budget, (stack, stage, id) =>
          markerOf(labels, stack, stage, id),
        );
  if (!trimmed) return marker;
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (text?.startsWith("[alc ")) {
    const end = text.indexOf("]");
    if (end < 0) return { labels: {}, text };
    const parts = text.slice("[alc ".length, end).trim().split(/\s+/);
    const labels: Record<string, string> = {};
    if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
    if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
    if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
    const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
    return { labels, text: rest.length > 0 ? rest : undefined };
  }
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownedByAlchemyLabels = (
  id: string,
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const observed = tagRecord(labels);
    if (!hasAlchemyLabelMap(observed)) return false;
    const exact = yield* hasAlchemyLabels(id, observed);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        observed[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        observed[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        observed[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isTransientGcpError,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.CES.DeleteNotConfirmed",
)<{}> {}

/** Poll until the resource is gone; fails if it is still readable after ~60s. */
export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === undefined,
      times: 30,
    }),
    Effect.flatMap((value): Effect.Effect<void, DeleteNotConfirmed> =>
      value === undefined ? Effect.void : Effect.fail(new DeleteNotConfirmed()),
    ),
  );

export const waitForVisible = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new CesPending({ name: "" }),
    ),
    Effect.retry({
      // New apps can take a couple of minutes to become readable.
      while: (error) => error instanceof CesPending,
      times: 40,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchIf(
      (error): error is CesPending => error instanceof CesPending,
      () => Effect.succeed(undefined),
    ),
  );

const emptyList = <A>() => Effect.succeed<A[]>([]);

type ListedError = ces.NotFound | ces.Forbidden | ces.GcpOpError;

export const collectPages = <Page, Item, R>(
  pages: Stream.Stream<Page, ListedError, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<Item>()),
  );

export const listApps = (parent: string) =>
  parent.length === 0
    ? emptyList<ces.App>()
    : collectPages(
        ces.listProjectsLocationsApps.pages({ parent, pageSize: 100 }),
        (page) => page.apps,
      );

export const namedApps = (project: string, location: string) =>
  listApps(locationParent(project, location)).pipe(
    Effect.map((apps) =>
      apps.filter(
        (app): app is ces.App & { name: string } =>
          typeof app.name === "string" && app.name.length > 0,
      ),
    ),
  );

export const forEachApp = <A, E, R>(
  project: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
  location: string,
) =>
  Effect.gen(function* () {
    // Children of Alchemy-owned apps (ownership lives in app metadata).
    const apps = (yield* namedApps(project, location)).filter((app) =>
      hasAlchemyLabelMap(app.metadata),
    );
    const groups = yield* Effect.forEach(apps, (app) => list(app.name), {
      concurrency: 4,
    });
    return groups.flat();
  });

export const DEFAULT_OPENAPI_SCHEMA = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Alchemy", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: {
          "200": { description: "ok" },
        },
      },
    },
  },
});

export const DEFAULT_CHANNEL_PROFILE: ces.ChannelProfile = {
  channelType: "API",
  profileId: "api",
};

export const toolKind = (tool: {
  fileSearchTool?: unknown;
  pythonFunction?: unknown;
  googleSearchTool?: unknown;
  mcpTool?: unknown;
  remoteAgentTool?: unknown;
  widgetTool?: unknown;
  systemTool?: unknown;
  openApiTool?: unknown;
  connectorTool?: unknown;
  dataStoreTool?: unknown;
  agentTool?: unknown;
  clientFunction?: unknown;
}) => {
  if (tool.fileSearchTool) return "fileSearchTool";
  if (tool.pythonFunction) return "pythonFunction";
  if (tool.googleSearchTool) return "googleSearchTool";
  if (tool.mcpTool) return "mcpTool";
  if (tool.remoteAgentTool) return "remoteAgentTool";
  if (tool.widgetTool) return "widgetTool";
  if (tool.systemTool) return "systemTool";
  if (tool.openApiTool) return "openApiTool";
  if (tool.connectorTool) return "connectorTool";
  if (tool.dataStoreTool) return "dataStoreTool";
  if (tool.agentTool) return "agentTool";
  return "clientFunction";
};

export const toolsetKind = (toolset: {
  openApiToolset?: unknown;
  mcpToolset?: unknown;
  connectorToolset?: unknown;
}) => {
  if (toolset.mcpToolset) return "mcpToolset";
  if (toolset.connectorToolset) return "connectorToolset";
  return "openApiToolset";
};

export const toolOwnershipText = (tool: ces.Tool) =>
  tool.clientFunction?.description ??
  tool.pythonFunction?.description ??
  tool.googleSearchTool?.description ??
  tool.fileSearchTool?.description ??
  tool.remoteAgentTool?.description ??
  tool.widgetTool?.description ??
  tool.openApiTool?.description ??
  tool.connectorTool?.description ??
  tool.dataStoreTool?.description ??
  tool.agentTool?.description ??
  tool.systemTool?.description ??
  tool.mcpTool?.description;

export const stampToolDescription = (
  tool: ces.Tool,
  ownership: Record<string, string>,
): ces.Tool => {
  const stamp = (text: string | undefined) => encodeOwnership(ownership, text);
  if (tool.pythonFunction) {
    return {
      ...tool,
      pythonFunction: {
        ...tool.pythonFunction,
        description: stamp(tool.pythonFunction.description),
      },
    };
  }
  if (tool.googleSearchTool) {
    return {
      ...tool,
      googleSearchTool: {
        ...tool.googleSearchTool,
        description: stamp(tool.googleSearchTool.description),
      },
    };
  }
  if (tool.fileSearchTool) {
    return {
      ...tool,
      fileSearchTool: {
        ...tool.fileSearchTool,
        description: stamp(tool.fileSearchTool.description),
      },
    };
  }
  if (tool.remoteAgentTool) {
    return {
      ...tool,
      remoteAgentTool: {
        ...tool.remoteAgentTool,
        description: stamp(tool.remoteAgentTool.description),
      },
    };
  }
  if (tool.widgetTool) {
    return {
      ...tool,
      widgetTool: {
        ...tool.widgetTool,
        description: stamp(tool.widgetTool.description),
      },
    };
  }
  if (tool.openApiTool) {
    return {
      ...tool,
      openApiTool: {
        ...tool.openApiTool,
        description: stamp(tool.openApiTool.description),
      },
    };
  }
  if (tool.connectorTool) {
    return {
      ...tool,
      connectorTool: {
        ...tool.connectorTool,
        description: stamp(tool.connectorTool.description),
      },
    };
  }
  if (tool.dataStoreTool) {
    return {
      ...tool,
      dataStoreTool: {
        ...tool.dataStoreTool,
        description: stamp(tool.dataStoreTool.description),
      },
    };
  }
  if (tool.agentTool) {
    return {
      ...tool,
      agentTool: {
        ...tool.agentTool,
        description: stamp(tool.agentTool.description),
      },
    };
  }
  if (tool.systemTool) {
    return {
      ...tool,
      systemTool: {
        ...tool.systemTool,
        description: stamp(tool.systemTool.description),
      },
    };
  }
  if (tool.mcpTool) {
    return {
      ...tool,
      mcpTool: {
        ...tool.mcpTool,
        description: stamp(tool.mcpTool.description),
      },
    };
  }
  return {
    ...tool,
    clientFunction: {
      name: tool.clientFunction?.name ?? "alchemy_fn",
      description: stamp(tool.clientFunction?.description),
      parameters: tool.clientFunction?.parameters,
      response: tool.clientFunction?.response,
    },
  };
};

export const unstampToolDescription = (tool: ces.Tool): ces.Tool => {
  const unstamp = (text: string | undefined) => parseOwnership(text).text;
  if (tool.pythonFunction) {
    return {
      ...tool,
      pythonFunction: {
        ...tool.pythonFunction,
        description: unstamp(tool.pythonFunction.description),
      },
    };
  }
  if (tool.googleSearchTool) {
    return {
      ...tool,
      googleSearchTool: {
        ...tool.googleSearchTool,
        description: unstamp(tool.googleSearchTool.description),
      },
    };
  }
  if (tool.fileSearchTool) {
    return {
      ...tool,
      fileSearchTool: {
        ...tool.fileSearchTool,
        description: unstamp(tool.fileSearchTool.description),
      },
    };
  }
  if (tool.remoteAgentTool) {
    return {
      ...tool,
      remoteAgentTool: {
        ...tool.remoteAgentTool,
        description: unstamp(tool.remoteAgentTool.description),
      },
    };
  }
  if (tool.widgetTool) {
    return {
      ...tool,
      widgetTool: {
        ...tool.widgetTool,
        description: unstamp(tool.widgetTool.description),
      },
    };
  }
  if (tool.openApiTool) {
    return {
      ...tool,
      openApiTool: {
        ...tool.openApiTool,
        description: unstamp(tool.openApiTool.description),
      },
    };
  }
  if (tool.connectorTool) {
    return {
      ...tool,
      connectorTool: {
        ...tool.connectorTool,
        description: unstamp(tool.connectorTool.description),
      },
    };
  }
  if (tool.dataStoreTool) {
    return {
      ...tool,
      dataStoreTool: {
        ...tool.dataStoreTool,
        description: unstamp(tool.dataStoreTool.description),
      },
    };
  }
  if (tool.agentTool) {
    return {
      ...tool,
      agentTool: {
        ...tool.agentTool,
        description: unstamp(tool.agentTool.description),
      },
    };
  }
  if (tool.systemTool) {
    return {
      ...tool,
      systemTool: {
        ...tool.systemTool,
        description: unstamp(tool.systemTool.description),
      },
    };
  }
  if (tool.mcpTool) {
    return {
      ...tool,
      mcpTool: {
        ...tool.mcpTool,
        description: unstamp(tool.mcpTool.description),
      },
    };
  }
  if (tool.clientFunction) {
    return {
      ...tool,
      clientFunction: {
        ...tool.clientFunction,
        description: unstamp(tool.clientFunction.description),
      },
    };
  }
  return tool;
};
