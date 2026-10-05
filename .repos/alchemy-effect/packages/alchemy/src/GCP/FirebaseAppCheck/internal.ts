import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as firebase from "@distilled.cloud/gcp/firebase_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

export const DEFAULT_SERVICE_ID = "oauth2.googleapis.com";
export const DEFAULT_ENFORCEMENT_MODE = "UNENFORCED";
export const RESOURCE_POLICY_SERVICES = [DEFAULT_SERVICE_ID] as const;
export const DUMMY_CLIENT_PREFIX = "alc-";
export const MAX_DISPLAY_NAME = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.FirebaseAppCheck.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectParent = (project: string) => `projects/${project}`;

export const expandApp = (project: string, value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/apps/")) return trimmed;
  return `${projectParent(project)}/apps/${trimmed}`;
};

export const appIdOf = (app: string) => {
  const parts = app.split("/").filter((part) => part.length > 0);
  const appsAt = parts.lastIndexOf("apps");
  return appsAt >= 0 && parts[appsAt + 1]
    ? parts[appsAt + 1]!
    : lastSegment(app);
};

export const parseDebugTokenName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const projectsAt = parts.lastIndexOf("projects");
  const appsAt = parts.lastIndexOf("apps");
  const tokensAt = parts.lastIndexOf("debugTokens");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    appId: appsAt >= 0 && parts[appsAt + 1] ? parts[appsAt + 1]! : "",
    debugTokenId:
      tokensAt >= 0 && parts[tokensAt + 1]
        ? parts[tokensAt + 1]!
        : lastSegment(name),
    app:
      appsAt >= 0
        ? parts.slice(0, tokensAt >= 0 ? tokensAt : parts.length).join("/")
        : "",
  };
};

export const parseResourcePolicyName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const projectsAt = parts.lastIndexOf("projects");
  const servicesAt = parts.lastIndexOf("services");
  const policiesAt = parts.lastIndexOf("resourcePolicies");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    serviceId:
      servicesAt >= 0 && parts[servicesAt + 1] ? parts[servicesAt + 1]! : "",
    resourcePolicyId:
      policiesAt >= 0 && parts[policiesAt + 1]
        ? parts[policiesAt + 1]!
        : lastSegment(name),
    parent:
      servicesAt >= 0
        ? parts.slice(0, policiesAt >= 0 ? policiesAt : parts.length).join("/")
        : "",
  };
};

export const serviceParent = (project: string, serviceId: string) =>
  `${projectParent(project)}/services/${serviceId}`;

export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const combined =
    displayName && displayName.length > 0 ? `${marker} ${displayName}` : marker;
  return combined.slice(0, 1024);
};

export const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alchemy ")) {
    return { labels: {}, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, displayName };
  const labels: Record<string, string> = {};
  for (const part of displayName.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = displayName.slice(end + 1).trim();
  return { labels, displayName: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (displayName: string | undefined) =>
  Object.keys(parseDisplayName(displayName).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, displayName: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDisplayName(displayName);
    return yield* hasAlchemyLabels(id, labels);
  });

export const createOwnership = (id: string) => createInternalLabels(id);

export const dummyClientId = (labels: Record<string, string>) => {
  const id = labels[alchemyLabelKeys.id] ?? "x";
  return `${DUMMY_CLIENT_PREFIX}${id}`.slice(0, 63);
};

export const dummyTargetResource = (
  project: string,
  labels: Record<string, string>,
) =>
  `//oauth2.googleapis.com/projects/${project}/oauthClients/${dummyClientId(labels)}`;

export const hasDummyAlchemyTarget = (targetResource: string | undefined) =>
  lastSegment(targetResource ?? "").startsWith(DUMMY_CLIENT_PREFIX);

export const ownedDummyTarget = (
  targetResource: string | undefined,
  labels: Record<string, string>,
) => lastSegment(targetResource ?? "") === dummyClientId(labels);

export const toDisplayName = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: MAX_DISPLAY_NAME,
      lowercase: true,
    });
  });

export const randomUuid4 = () => Effect.sync(() => crypto.randomUUID());

export const toToken = (explicit: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) return explicit;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* randomUuid4();
  });

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameTextInsensitive = (
  left: string | undefined,
  right: string | undefined,
) => (left ?? "").toLowerCase() === (right ?? "").toLowerCase();

export const normalizeEnforcement = (value: string | undefined) =>
  (value ?? DEFAULT_ENFORCEMENT_MODE).toUpperCase();

export const replaceOnIdentity = (input: {
  previous?: string;
  next?: string;
  extra?: boolean;
  deleteFirst?: boolean;
}) => {
  if (input.extra === true) {
    return {
      action: "replace" as const,
      deleteFirst: input.deleteFirst !== false,
    };
  }
  if (
    input.previous !== undefined &&
    input.next !== undefined &&
    input.previous !== input.next
  ) {
    return {
      action: "replace" as const,
      deleteFirst: input.deleteFirst !== false,
    };
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

export const getDebugToken = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : firebaseappcheck
        .getProjectsAppsDebugTokens({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getResourcePolicy = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : firebaseappcheck
        .getProjectsServicesResourcePolicies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
  );

export const listFirebaseApps = (project: string) =>
  collectPages(
    firebase.searchAppsProjects.pages({
      parent: projectParent(project),
      pageSize: 100,
    }),
    (page) => page.apps,
  ).pipe(
    Effect.catchTag("NotFound", () => emptyList<firebase.FirebaseAppInfo>()),
  );

export const listDebugTokensForApp = (app: string) =>
  collectPages(
    firebaseappcheck.listProjectsAppsDebugTokens.pages({
      parent: app,
      pageSize: 20,
    }),
    (page) => page.debugTokens,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      emptyList<firebaseappcheck.GoogleFirebaseAppcheckV1DebugToken>(),
    ),
  );

export const listOwnedDebugTokens = (project: string) =>
  Effect.gen(function* () {
    const apps = yield* listFirebaseApps(project);
    const pages = yield* Effect.forEach(
      apps.filter((app) => (app.appId ?? "").length > 0),
      (app) => listDebugTokensForApp(expandApp(project, app.appId ?? "")),
      { concurrency: 5 },
    );
    return pages
      .flat()
      .filter((token) => hasOwnershipMarker(token.displayName));
  });

export const findOwnedDebugToken = (
  tokens: readonly firebaseappcheck.GoogleFirebaseAppcheckV1DebugToken[],
  id: string,
  name?: string,
) =>
  Effect.gen(function* () {
    if (name) {
      const match = tokens.find((token) => token.name === name);
      if (match) return match;
    }
    for (const token of tokens) {
      if (yield* ownedByAlchemy(id, token.displayName)) return token;
    }
    return undefined;
  });

export const listResourcePolicies = (project: string, serviceId: string) =>
  collectPages(
    firebaseappcheck.listProjectsServicesResourcePolicies.pages({
      parent: serviceParent(project, serviceId),
      pageSize: 100,
    }),
    (page) => page.resourcePolicies,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      emptyList<firebaseappcheck.GoogleFirebaseAppcheckV1ResourcePolicy>(),
    ),
  );

export const listOwnedResourcePolicies = (project: string) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(
      RESOURCE_POLICY_SERVICES,
      (serviceId) => listResourcePolicies(project, serviceId),
      { concurrency: 2 },
    );
    return pages
      .flat()
      .filter((policy) => hasDummyAlchemyTarget(policy.targetResource));
  });

export const findOwnedResourcePolicy = (
  policies: readonly firebaseappcheck.GoogleFirebaseAppcheckV1ResourcePolicy[],
  labels: Record<string, string>,
  name?: string,
) => {
  if (name) {
    const match = policies.find((policy) => policy.name === name);
    if (match) return match;
  }
  return policies.find((policy) =>
    ownedDummyTarget(policy.targetResource, labels),
  );
};
