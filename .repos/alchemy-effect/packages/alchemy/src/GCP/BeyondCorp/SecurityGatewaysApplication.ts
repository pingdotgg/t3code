import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_GLOBAL,
  ResourceNotResolved,
  collectPages,
  encodeOwnershipLine,
  expandName,
  fieldMask,
  fingerprint,
  hasOwnershipMarker,
  listAtLocation,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  rfc1035,
  toPhysicalId,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "applications";

export type SecurityGatewaysApplicationEndpointMatcher = {
  /** Hostname pattern (`example.com`, `*.example.com`). */
  hostname?: string;
  /** Ports that match this hostname. */
  ports?: number[];
};

export type SecurityGatewaysApplicationUpstream = {
  /** VPC network to forward traffic to. */
  network?: { name?: string };
  /** External endpoints to forward traffic to. */
  external?: {
    endpoints?: Array<{ hostname?: string; port?: number }>;
  };
  /** Optional proxy-protocol configuration for the upstream. */
  proxyProtocol?: beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1ProxyProtocolConfig;
  /** Regions where the application sends traffic. */
  egressPolicy?: { regions?: string[] };
};

export type SecurityGatewaysApplicationProps = {
  /**
   * Parent SecurityGateway resource name
   * (`projects/{project}/locations/{location}/securityGateways/{securityGateway}`)
   * or gateway id. Immutable — changing it replaces the application.
   */
  securityGateway: string;
  /**
   * Application id (the `{application}` segment of
   * `.../securityGateways/{securityGateway}/applications/{application}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the application.
   */
  applicationId?: string;
  /**
   * Location of the parent gateway. Inferred from `securityGateway`
   * when that value is a full resource name. Defaults to `global`.
   * Immutable — changing it replaces the application.
   * @default "global"
   */
  location?: string;
  /**
   * Endpoint matchers. The application matches when any matcher is
   * satisfied.
   */
  endpointMatchers: SecurityGatewaysApplicationEndpointMatcher[];
  /**
   * External application schema (`PROXY_GATEWAY`, `API_GATEWAY`).
   */
  schema?:
    | beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1ApplicationSchemaEnum
    | (string & {});
  /**
   * Upstream resources that receive matched traffic.
   */
  upstreams?: SecurityGatewaysApplicationUpstream[];
  /**
   * Human-readable name. Cannot exceed 64 characters. Application has
   * no labels field, so Alchemy stamps ownership into this value and
   * strips it from attributes.
   */
  displayName?: string;
};

export type SecurityGatewaysApplication = Resource<
  "GCP.BeyondCorp.SecurityGatewaysApplication",
  SecurityGatewaysApplicationProps,
  {
    /** Full resource name `.../securityGateways/{securityGateway}/applications/{application}`. */
    name: string;
    /** Application id (last path segment). */
    applicationId: string;
    /** Parent SecurityGateway resource name. */
    securityGateway: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** Endpoint matchers. */
    endpointMatchers: SecurityGatewaysApplicationEndpointMatcher[];
    /** External application schema. */
    schema: string | undefined;
    /** Upstream resources. */
    upstreams: SecurityGatewaysApplicationUpstream[];
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BeyondCorp Security Gateway application that matches host and
 * port combinations and forwards traffic to upstreams.
 *
 * The API has no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Changing the parent gateway,
 * application id, or location replaces the application. Display
 * name, endpoint matchers, schema, and upstreams update in place.
 *
 * ### Creating a SecurityGatewaysApplication
 * **Example:** Match HTTPS for a hostname
 * ```typescript
 * const app = yield* GCP.BeyondCorp.SecurityGatewaysApplication("Web", {
 *   securityGateway: gateway.name,
 *   endpointMatchers: [{ hostname: "app.example.com", ports: [443] }],
 * });
 * ```
 *
 * **Example:** External upstreams
 * ```typescript
 * const app = yield* GCP.BeyondCorp.SecurityGatewaysApplication("Web", {
 *   securityGateway: gateway.name,
 *   applicationId: "app-web",
 *   displayName: "prod web",
 *   endpointMatchers: [{ hostname: "app.example.com", ports: [80, 443] }],
 *   upstreams: [
 *     {
 *       external: {
 *         endpoints: [{ hostname: "origin.example.com", port: 443 }],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category BeyondCorp
 */
export const SecurityGatewaysApplication =
  Resource<SecurityGatewaysApplication>(
    "GCP.BeyondCorp.SecurityGatewaysApplication",
  );

const parentGatewayName = (
  project: string,
  location: string,
  securityGateway: string,
) => expandName(securityGateway, project, location, "securityGateways");

const resourceNameOf = (parent: string, applicationId: string) =>
  `${parent}/applications/${applicationId}`;

const parentFromName = (name: string) => {
  const index = name.lastIndexOf("/applications/");
  return index >= 0 ? name.slice(0, index) : name;
};

const locationFromParent = (securityGateway: string, fallback: string) => {
  if (!securityGateway.includes("/locations/")) return fallback;
  return parseName(securityGateway, "securityGateways", fallback).location;
};

const toMatchers = (
  matchers:
    | beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1EndpointMatcherList
    | undefined,
): SecurityGatewaysApplicationEndpointMatcher[] =>
  (matchers ?? []).map((matcher) => ({
    hostname: matcher.hostname,
    ports: matcher.ports ? [...matcher.ports] : undefined,
  }));

const toUpstreams = (
  upstreams:
    | beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1ApplicationUpstreamList
    | undefined,
): SecurityGatewaysApplicationUpstream[] =>
  (upstreams ?? []).map((upstream) => ({
    network: upstream.network ? { name: upstream.network.name } : undefined,
    external: upstream.external
      ? {
          endpoints: (upstream.external.endpoints ?? []).map((endpoint) => ({
            hostname: endpoint.hostname,
            port: endpoint.port,
          })),
        }
      : undefined,
    proxyProtocol: upstream.proxyProtocol,
    egressPolicy: upstream.egressPolicy
      ? {
          regions: upstream.egressPolicy.regions
            ? [...upstream.egressPolicy.regions]
            : undefined,
        }
      : undefined,
  }));

const toAttrs = (
  item: beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1Application,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  const ownership = parseOwnership(item.displayName);
  const parent = parentFromName(name);
  return {
    name,
    applicationId: parsed.id,
    securityGateway: parent,
    project: parsed.project || project,
    location: parsed.location,
    endpointMatchers: toMatchers(item.endpointMatchers),
    schema: item.schema === undefined ? undefined : `${item.schema}`,
    upstreams: toUpstreams(item.upstreams),
    displayName: ownership.text,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  beyondcorp
    .getProjectsLocationsSecurityGatewaysApplications({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const gateways = yield* listAtLocation(project, (parent) =>
      collectPages(
        beyondcorp.listProjectsLocationsSecurityGateways.pages({
          parent,
          pageSize: 1000,
        }),
        (
          page,
        ):
          | readonly beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1SecurityGateway[]
          | undefined => page.securityGateways,
      ),
    );
    const nested = yield* Effect.forEach(
      gateways.filter((gateway) => (gateway.name ?? "").length > 0),
      (gateway) =>
        collectPages(
          beyondcorp.listProjectsLocationsSecurityGatewaysApplications.pages({
            parent: gateway.name!,
            pageSize: 1000,
          }),
          (
            page,
          ):
            | readonly beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1Application[]
            | undefined => page.applications,
        ),
      { concurrency: 4 },
    );
    return nested.flat().filter((item) => hasOwnershipMarker(item.displayName));
  });

export const SecurityGatewaysApplicationProvider = () =>
  Provider.succeed(SecurityGatewaysApplication, {
    stables: [
      "name",
      "applicationId",
      "securityGateway",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      return replaceOnIdentity({
        previousId: olds?.applicationId ?? output?.applicationId,
        nextId: news.applicationId
          ? rfc1035(news.applicationId, "application")
          : (olds?.applicationId ?? output?.applicationId),
        previousLocation,
        nextLocation: normalizeLocation(
          news.location ??
            locationFromParent(news.securityGateway, previousLocation),
          DEFAULT_GLOBAL,
        ),
        previousParent: olds?.securityGateway ?? output?.securityGateway,
        nextParent: news.securityGateway,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          (olds?.securityGateway
            ? locationFromParent(olds.securityGateway, DEFAULT_GLOBAL)
            : undefined),
        DEFAULT_GLOBAL,
      );
      const applicationId = yield* toPhysicalId(
        id,
        olds?.applicationId,
        output?.applicationId,
        "application",
      );
      const parent = olds?.securityGateway
        ? parentGatewayName(env.project, location, olds.securityGateway)
        : output?.securityGateway;
      const name =
        output?.name ??
        (parent ? resourceNameOf(parent, applicationId) : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
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
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromParent(news.securityGateway, DEFAULT_GLOBAL),
        DEFAULT_GLOBAL,
      );
      const applicationId = yield* toPhysicalId(
        id,
        news.applicationId,
        output?.applicationId,
        "application",
      );
      const parent = parentGatewayName(
        env.project,
        location,
        news.securityGateway,
      );
      const name = resourceNameOf(parent, applicationId);
      const ownership = yield* createInternalLabels(id);
      const desiredDisplayName = encodeOwnershipLine(
        ownership,
        news.displayName,
      );
      const endpointMatchers = news.endpointMatchers.map((matcher) => ({
        hostname: matcher.hostname,
        ports: matcher.ports,
      }));
      const upstreams = news.upstreams;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* beyondcorp
          .createProjectsLocationsSecurityGatewaysApplications({
            parent,
            applicationId,
            body: {
              displayName: desiredDisplayName,
              endpointMatchers,
              schema: news.schema,
              upstreams,
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

      const mask = fieldMask([
        (current.displayName ?? "") !== desiredDisplayName && "display_name",
        fingerprint(toMatchers(current.endpointMatchers)) !==
          fingerprint(endpointMatchers) && "endpoint_matchers",
        (current.schema ?? "") !== (news.schema ?? "") && "schema",
        fingerprint(toUpstreams(current.upstreams)) !==
          fingerprint(upstreams) && "upstreams",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* beyondcorp.patchProjectsLocationsSecurityGatewaysApplications({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              displayName: desiredDisplayName,
              endpointMatchers,
              schema: news.schema,
              upstreams,
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
      const operation = yield* beyondcorp
        .deleteProjectsLocationsSecurityGatewaysApplications({
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
