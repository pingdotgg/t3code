import * as firebaseapphosting from "@distilled.cloud/gcp/firebaseapphosting_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  fieldMask,
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameBool,
  sameText,
  stringMap,
  toDomainId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type Redirect = {
  /**
   * Redirect destination URI. URIs without a scheme are assumed to be
   * HTTPS. Prepended to the original request path.
   */
  uri?: string;
  /**
   * HTTP 3xx status used in the redirect response.
   * @default "302"
   */
  status?: string;
};

export type ServingBehavior = {
  /** Redirect behavior. When set, the domain does not serve live content. */
  redirect?: Redirect;
};

export type BackendsDomainProps = {
  /**
   * Parent backend. Full name
   * `projects/{project}/locations/{location}/backends/{backend}` or the
   * backend id (combined with `location`). Immutable — changing it
   * replaces the domain.
   */
  backend: string;
  /**
   * Region used when `backend` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Domain id — a valid domain name (for example `www.example.com`).
   * If omitted, a unique `{id}.example.com` name is generated.
   * Immutable — changing it replaces the domain.
   */
  domainId?: string;
  /**
   * Serving behavior. When set, the domain serves something other than
   * the backend's live content (typically a redirect).
   */
  serve?: ServingBehavior;
  /**
   * Human-readable name. 63 character limit.
   */
  displayName?: string;
  /**
   * When true, the domain is disabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * User annotations (preserved by external tools).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackendsDomain = Resource<
  "GCP.FirebaseAppHosting.BackendsDomain",
  BackendsDomainProps,
  {
    /** Full resource name. */
    name: string;
    /** Domain id (last path segment, a domain name). */
    domainId: string;
    /** Parent backend name. */
    backend: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Serving behavior. */
    serve: ServingBehavior | undefined;
    /** Human-readable name. */
    displayName: string | undefined;
    /** Whether the domain is disabled. */
    disabled: boolean;
    /** Domain type (`DEFAULT` or `CUSTOM`). */
    type: string | undefined;
    /** Custom-domain linkage status. */
    customDomainStatus: firebaseapphosting.CustomDomainStatus | undefined;
    /** True while the domain has an ongoing LRO. */
    reconciling: boolean;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-computed etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A domain name linked to a Firebase App Hosting backend. Default
 * domains are created with the backend; this resource manages custom
 * domains.
 *
 * Changing `domainId`, `backend`, or `location` replaces the domain.
 * Serving behavior, display name, disabled, labels, and annotations
 * update in place.
 *
 * ### Creating a Domain
 * **Example:** Custom domain
 * ```typescript
 * const domain = yield* GCP.FirebaseAppHosting.BackendsDomain("Www", {
 *   backend: backend.name,
 *   domainId: "www.example.com",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Redirect
 * ```typescript
 * const domain = yield* GCP.FirebaseAppHosting.BackendsDomain("Apex", {
 *   backend: backend.name,
 *   domainId: "example.com",
 *   serve: { redirect: { uri: "https://www.example.com", status: "301" } },
 * });
 * ```
 *
 * ### Updating a Domain
 * **Example:** Disable and relabel
 * ```typescript
 * const domain = yield* GCP.FirebaseAppHosting.BackendsDomain("Www", {
 *   domainId: "www.example.com",
 *   backend: backend.name,
 *   disabled: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category FirebaseAppHosting
 */
export const BackendsDomain = Resource<BackendsDomain>(
  "GCP.FirebaseAppHosting.BackendsDomain",
);

const resourceName = (backend: string, domainId: string) =>
  `${backend}/domains/${domainId}`;

const toServe = (
  value: firebaseapphosting.ServingBehavior | undefined,
): ServingBehavior | undefined =>
  value === undefined
    ? undefined
    : {
        redirect: value.redirect
          ? { uri: value.redirect.uri, status: value.redirect.status }
          : undefined,
      };

const toAttrs = (item: firebaseapphosting.Domain, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "domains");
  return {
    name,
    domainId: parsed.id,
    backend: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    serve: toServe(item.serve),
    displayName: item.displayName,
    disabled: item.disabled === true,
    type: item.type,
    customDomainStatus: item.customDomainStatus,
    reconciling: item.reconciling === true,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  firebaseapphosting
    .getProjectsLocationsBackendsDomains({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "backends/-", (parent) =>
    listLabeledPages(
      firebaseapphosting.listProjectsLocationsBackendsDomains.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.domains,
      (item) => item.labels,
    ),
  );

export const BackendsDomainProvider = () =>
  Provider.succeed(BackendsDomain, {
    stables: [
      "name",
      "domainId",
      "backend",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const previousParent =
        (olds?.backend ?? output?.backend)
          ? expandParent(
              olds?.backend ?? output?.backend ?? "",
              env.project,
              previousLocation,
              "backends",
            )
          : undefined;
      const nextParent = expandParent(
        news.backend,
        env.project,
        location,
        "backends",
      );
      return replaceOnIdentity({
        previousId: olds?.domainId ?? output?.domainId,
        nextId: news.domainId ?? olds?.domainId ?? output?.domainId,
        previousLocation,
        nextLocation: location,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const domainId = yield* toDomainId(id, olds?.domainId, output?.domainId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const backend =
        output?.backend ??
        (olds?.backend
          ? expandParent(olds.backend, env.project, location, "backends")
          : undefined);
      const name =
        output?.name ?? (backend ? resourceName(backend, domainId) : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const domainId = yield* toDomainId(id, news.domainId, output?.domainId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const backend = expandParent(
        news.backend,
        env.project,
        location,
        "backends",
      );
      const name = resourceName(backend, domainId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredDisabled = news.disabled === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* firebaseapphosting
          .createProjectsLocationsBackendsDomains({
            parent: backend,
            domainId,
            body: {
              serve: news.serve,
              displayName: news.displayName,
              disabled: desiredDisabled,
              annotations: desiredAnnotations,
              labels: desiredLabels,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        !sameText(current.displayName, news.displayName) && "displayName",
        !sameBool(current.disabled, desiredDisabled) && "disabled",
        fingerprint(toServe(current.serve)) !== fingerprint(news.serve) &&
          "serve",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* firebaseapphosting.patchProjectsLocationsBackendsDomains({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              serve: news.serve,
              displayName: news.displayName,
              disabled: desiredDisabled,
              annotations: desiredAnnotations,
              labels: desiredLabels,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* firebaseapphosting
        .deleteProjectsLocationsBackendsDomains({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
