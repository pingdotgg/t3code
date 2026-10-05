import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  expandParent,
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  listAtLocation,
} from "./internal.ts";

export type ConnectionsGitRepositoryLinkProps = {
  /**
   * Parent Developer Connect connection. Full name
   * `projects/{project}/locations/{location}/connections/{connection}`
   * or the connection id (combined with `location`). Immutable —
   * changing it replaces the link.
   */
  connection: string;
  /**
   * Region used when `connection` is a bare id. Immutable — changing
   * it replaces the link. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Git repository link id (the `{gitRepositoryLink}` segment of
   * `{connection}/gitRepositoryLinks/{gitRepositoryLink}`). If omitted,
   * a unique RFC1035 name is generated. Unique within the connection.
   * Immutable — changing it replaces the link.
   */
  gitRepositoryLinkId?: string;
  /**
   * Git clone HTTPS URI (e.g. `https://github.com/{owner}/{repo}.git`).
   * Immutable — changing it replaces the link.
   */
  cloneUri: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The API has no patch method — changing labels replaces the link.
   */
  labels?: Record<string, string>;
  /**
   * User annotations (AIP-148). The API has no patch method — changing
   * annotations replaces the link.
   */
  annotations?: Record<string, string>;
};

export type ConnectionsGitRepositoryLink = Resource<
  "GCP.DeveloperConnect.ConnectionsGitRepositoryLink",
  ConnectionsGitRepositoryLinkProps,
  {
    /** Full resource name. */
    name: string;
    /** Git repository link id (last path segment). */
    gitRepositoryLinkId: string;
    /** Parent connection resource name. */
    connection: string;
    /** Connection id (last path segment of the parent). */
    connectionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Git clone HTTPS URI. */
    cloneUri: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** External id of the webhook created for the repository. */
    webhookId: string | undefined;
    /** Git proxy URI when the parent connection has git proxy enabled. */
    gitProxyUri: string | undefined;
    /** True while Developer Connect is applying the link. */
    reconciling: boolean;
    /** Server checksum of the resource. */
    etag: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Developer Connect git repository link — associates a remote Git
 * repository with a {@link Connection} so webhooks and clone tokens
 * can be issued.
 *
 * Changing `gitRepositoryLinkId`, `connection`, `location`, `cloneUri`,
 * labels, or annotations replaces the link. There is no update API;
 * every user-facing field is immutable.
 *
 * ### Creating a Git Repository Link
 * **Example:** Generated name
 * ```typescript
 * const github = yield* GCP.DeveloperConnect.Connection("Github", {
 *   githubConfig: { githubApp: "DEVELOPER_CONNECT" },
 * });
 * const source = yield* GCP.DeveloperConnect.ConnectionsGitRepositoryLink(
 *   "Source",
 *   {
 *     connection: github.name,
 *     cloneUri: "https://github.com/{owner}/{repo}.git",
 *   },
 * );
 * ```
 *
 * **Example:** Named link with labels
 * ```typescript
 * const source = yield* GCP.DeveloperConnect.ConnectionsGitRepositoryLink(
 *   "Source",
 *   {
 *     connection: github.name,
 *     gitRepositoryLinkId: "app-source",
 *     cloneUri: "https://github.com/{owner}/{repo}.git",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * ### Fetching Git Refs
 * **Example:** List branches
 * ```typescript
 * const fetchGitRefs = yield* GCP.DeveloperConnect.FetchGitRefs(source);
 * const { refNames } = yield* fetchGitRefs({ refType: "BRANCH" });
 * ```
 *
 * ### Cloning with a Token
 * **Example:** Fetch a read token
 * ```typescript
 * const fetchReadToken = yield* GCP.DeveloperConnect.FetchReadToken(source);
 * const { token } = yield* fetchReadToken();
 * ```
 *
 * @resource
 * @category DeveloperConnect
 */
export const ConnectionsGitRepositoryLink =
  Resource<ConnectionsGitRepositoryLink>(
    "GCP.DeveloperConnect.ConnectionsGitRepositoryLink",
  );

const parseLinkName = (name: string, region: string) => {
  const parsed = parseName(name, "gitRepositoryLinks", region);
  const connectionParsed = parseName(parsed.parent, "connections", region);
  return {
    project: parsed.project,
    location: parsed.location,
    gitRepositoryLinkId: parsed.id,
    connection: parsed.parent,
    connectionId: connectionParsed.id,
  };
};

const resolveParent = (
  project: string,
  connection: string,
  location: string | undefined,
  region: string,
) => {
  if (connection.includes("/")) {
    const parsed = parseLinkName(
      connection.includes("/gitRepositoryLinks/")
        ? connection
        : `${connection.replace(/\/+$/, "")}/gitRepositoryLinks/_`,
      region,
    );
    return {
      parent: parsed.connection,
      location: parsed.location,
      project: parsed.project || project,
      connectionId: parsed.connectionId,
    };
  }
  const loc = normalizeLocation(location, region);
  return {
    parent: expandParent(connection, project, loc, "connections"),
    location: loc,
    project,
    connectionId: connection,
  };
};

const parentKey = (
  connection: string | undefined,
  location: string | undefined,
  region: string,
) => {
  if (connection === undefined || connection === "") return undefined;
  const parsed = resolveParent("", connection, location, region);
  return `${parsed.location}/${parsed.connectionId}`;
};

const resourceName = (parent: string, gitRepositoryLinkId: string) =>
  `${parent}/gitRepositoryLinks/${gitRepositoryLinkId}`;

const toAttrs = (
  item: developerconnect.GitRepositoryLink,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseLinkName(name, region);
  return {
    name,
    gitRepositoryLinkId: parsed.gitRepositoryLinkId,
    connection: parsed.connection,
    connectionId: parsed.connectionId,
    project: parsed.project || project,
    location: parsed.location,
    cloneUri: item.cloneUri ?? "",
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    webhookId: item.webhookId,
    gitProxyUri: item.gitProxyUri,
    reconciling: item.reconciling === true,
    etag: item.etag,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  developerconnect
    .getProjectsLocationsConnectionsGitRepositoryLinks({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listLinksAt = (parent: string) =>
  listLabeledPages(
    developerconnect.listProjectsLocationsConnectionsGitRepositoryLinks.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.gitRepositoryLinks,
    (item) => item.labels,
  );

const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const wildcard = yield* listAtNested(
      project,
      "connections/-",
      region,
      (parent) => listLinksAt(parent),
    );
    if (wildcard.length > 0) return wildcard;
    const connections = yield* listAtLocation(project, region, (parent) =>
      collectPages(
        developerconnect.listProjectsLocationsConnections.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.connections,
      ),
    );
    const pages = yield* Effect.forEach(
      connections,
      (connection) =>
        connection.name
          ? listLinksAt(connection.name)
          : Effect.succeed([] as developerconnect.GitRepositoryLink[]),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const ConnectionsGitRepositoryLinkProvider = () =>
  Provider.succeed(ConnectionsGitRepositoryLink, {
    stables: [
      "name",
      "gitRepositoryLinkId",
      "connection",
      "connectionId",
      "project",
      "location",
      "cloneUri",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      if (output === undefined && olds === undefined) return undefined;
      const previousUri = olds?.cloneUri ?? output?.cloneUri ?? "";
      const nextUri = news.cloneUri ?? previousUri;
      return replaceOnIdentity({
        previousId: olds?.gitRepositoryLinkId ?? output?.gitRepositoryLinkId,
        nextId:
          news.gitRepositoryLinkId ??
          olds?.gitRepositoryLinkId ??
          output?.gitRepositoryLinkId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: parentKey(
          olds?.connection ?? output?.connection,
          olds?.location ?? output?.location,
          env.region,
        ),
        nextParent:
          news.connection !== undefined
            ? parentKey(
                news.connection,
                news.location ?? olds?.location ?? output?.location,
                env.region,
              )
            : parentKey(
                olds?.connection ?? output?.connection,
                news.location ?? olds?.location ?? output?.location,
                env.region,
              ),
        extra:
          (previousUri !== "" && nextUri !== previousUri) ||
          fingerprint(toLabels(olds?.labels ?? output?.labels)) !==
            fingerprint(toLabels(news.labels)) ||
          fingerprint(olds?.annotations ?? output?.annotations) !==
            fingerprint(news.annotations),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      let name = output?.name;
      if (name === undefined || name.length === 0) {
        const connectionRef = olds?.connection ?? output?.connection;
        if (typeof connectionRef !== "string" || connectionRef.length === 0) {
          return undefined;
        }
        const gitRepositoryLinkId = yield* toPhysicalId(
          id,
          olds?.gitRepositoryLinkId,
          output?.gitRepositoryLinkId,
          "gitrepositorylink",
        );
        const parent = resolveParent(
          env.project,
          connectionRef,
          olds?.location ?? output?.location,
          env.region,
        );
        name = resourceName(parent.parent, gitRepositoryLinkId);
      }
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const gitRepositoryLinkId = yield* toPhysicalId(
        id,
        news.gitRepositoryLinkId,
        output?.gitRepositoryLinkId,
        "gitrepositorylink",
      );
      const parent = resolveParent(
        env.project,
        news.connection ?? output?.connection ?? "",
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(parent.parent, gitRepositoryLinkId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* developerconnect
          .createProjectsLocationsConnectionsGitRepositoryLinks({
            parent: parent.parent,
            gitRepositoryLinkId,
            body: {
              cloneUri: news.cloneUri,
              labels: desiredLabels,
              annotations: news.annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name === undefined || name.length === 0) return;
      const operation = yield* developerconnect
        .deleteProjectsLocationsConnectionsGitRepositoryLinks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(name), name);
    }),
  });
