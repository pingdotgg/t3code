import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  emptyOnMissing,
  environmentIdOf,
  environmentNameOf,
  lastSegment,
  listProjectEnvironments,
  missingToUndefined,
  organizationIdOf,
  organizationNameOf,
  sameText,
  segmentAfter,
  toResourceId,
} from "./common.ts";

export type EnvironmentsApisRevisionsDebugsessionProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the session.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the session.
   */
  environment: string;
  /**
   * API proxy id. Immutable — changing it replaces the session.
   */
  api: string;
  /**
   * Deployed revision id. Immutable — changing it replaces the session.
   */
  revision: string;
  /**
   * Debug session id. If omitted, a unique name is generated. Sessions
   * have no labels; Alchemy uses this id as the ownership marker for
   * `list` / nuke. Immutable — changing it replaces the session.
   */
  debugsessionId?: string;
  /**
   * Seconds after which the session ends. Overrides `timeout` query
   * when both are set.
   */
  timeout?: string;
  /**
   * Condition evaluated against the request to decide whether to trace
   * it. Syntax matches an API proxy flow Condition.
   */
  filter?: string;
  /**
   * Seconds the session stays valid in the control plane. Min 1, max 15,
   * default 10.
   */
  validity?: number;
  /**
   * Number of requests to trace. Min 1, max 15, default 10.
   */
  count?: number;
  /**
   * Maximum bytes captured from the response payload. Min 0, max 5120,
   * default 5120.
   */
  tracesize?: number;
};

export type EnvironmentsApisRevisionsDebugsession = Resource<
  "GCP.Apigee.EnvironmentsApisRevisionsDebugsession",
  EnvironmentsApisRevisionsDebugsessionProps,
  {
    /** Full resource name `…/apis/{api}/revisions/{revision}/debugsessions/{id}`. */
    name: string;
    /** Debug session id. */
    debugsessionId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** API proxy id. */
    api: string;
    /** Revision id. */
    revision: string;
    /** Timeout seconds, if set. */
    timeout: string | undefined;
    /** Trace filter, if set. */
    filter: string | undefined;
    /** Validity seconds. */
    validity: number | undefined;
    /** Request count. */
    count: number | undefined;
    /** Trace size bytes. */
    tracesize: number | undefined;
    /** First transaction creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee debug session for a deployed API proxy revision.
 *
 * Sessions are short-lived (max 15s validity) and have no labels.
 * Alchemy generates a stable session id from the stack so `list` can
 * match it. Delete clears captured data (`debugsessions.deleteData`);
 * it does not cancel an already-running session.
 *
 * ### Creating a Debug Session
 * **Example:** Trace ten requests
 * ```typescript
 * const session = yield* GCP.Apigee.EnvironmentsApisRevisionsDebugsession("Trace", {
 *   environment: "eval",
 *   api: "hello",
 *   revision: "1",
 *   count: 10,
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsApisRevisionsDebugsession =
  Resource<EnvironmentsApisRevisionsDebugsession>(
    "GCP.Apigee.EnvironmentsApisRevisionsDebugsession",
  );

export class EnvironmentsApisRevisionsDebugsessionNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsApisRevisionsDebugsessionNotResolved",
)<{
  name: string;
}> {}

const revisionParent = (
  organizationId: string,
  environmentId: string,
  api: string,
  revision: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/apis/${api}/revisions/${revision}`;

const sessionName = (parent: string, debugsessionId: string) =>
  `${parent}/debugsessions/${debugsessionId}`;

const parseSessionName = (name: string) => ({
  organizationId: segmentAfter(name, "organizations") ?? "",
  environmentId: segmentAfter(name, "environments") ?? "",
  api: segmentAfter(name, "apis") ?? "",
  revision: segmentAfter(name, "revisions") ?? "",
  debugsessionId: segmentAfter(name, "debugsessions") ?? lastSegment(name),
});

const toAttrs = (
  session: apigee.GoogleCloudApigeeV1DebugSession,
  organizationId: string,
  environmentId: string,
  api: string,
  revision: string,
) => {
  const raw = session.name ?? "";
  const parsed = parseSessionName(raw.includes("/") ? raw : "");
  const debugsessionId = parsed.debugsessionId || lastSegment(raw) || raw;
  const parent = revisionParent(
    parsed.organizationId || organizationId,
    parsed.environmentId || environmentId,
    parsed.api || api,
    parsed.revision || revision,
  );
  return {
    name: raw.includes("/") ? raw : sessionName(parent, debugsessionId),
    debugsessionId,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    api: parsed.api || api,
    revision: parsed.revision || revision,
    timeout: session.timeout,
    filter: session.filter,
    validity: session.validity,
    count: session.count,
    tracesize: session.tracesize,
    createTime: session.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : missingToUndefined(
        apigee.getOrganizationsEnvironmentsApisRevisionsDebugsessions({
          name,
        }),
      );

const listAtRevision = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as apigee.GoogleCloudApigeeV1Session[])
    : apigee.listOrganizationsEnvironmentsApisRevisionsDebugsessions
        .pages({ parent, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.sessions ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed([] as apigee.GoogleCloudApigeeV1Session[]),
          ),
        );

const listOrgApis = (organizationId: string) =>
  emptyOnMissing(
    apigee.listOrganizationsApis({
      parent: organizationNameOf(organizationId),
      includeMetaData: false,
    }),
    { proxies: [] as apigee.GoogleCloudApigeeV1ApiProxyList },
  ).pipe(Effect.map((page) => page.proxies ?? []));

const listApiSessions = (apiName: string) =>
  apigee.listOrganizationsApisDebugsessions
    .pages({ parent: apiName, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sessions ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([] as apigee.GoogleCloudApigeeV1ApiDebugSession[]),
      ),
    );

const isAlchemySessionId = (id: string | undefined) =>
  (id ?? "").startsWith("alch-") || (id ?? "").includes("alchemy");

export const EnvironmentsApisRevisionsDebugsessionProvider = () =>
  Provider.succeed(EnvironmentsApisRevisionsDebugsession, {
    stables: [
      "name",
      "debugsessionId",
      "organizationId",
      "environmentId",
      "api",
      "revision",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const previousApi = olds?.api ?? output?.api;
      const previousRevision = olds?.revision ?? output?.revision;
      const previousId = olds?.debugsessionId ?? output?.debugsessionId;
      if (
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          organizationIdOf(news.organization, "") !==
            organizationIdOf(previousOrg, "")) ||
        (previousEnv !== undefined &&
          environmentIdOf(news.environment) !== environmentIdOf(previousEnv)) ||
        (previousApi !== undefined && news.api !== previousApi) ||
        (previousRevision !== undefined &&
          news.revision !== previousRevision) ||
        (previousId !== undefined &&
          news.debugsessionId !== undefined &&
          news.debugsessionId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(
        olds?.organization ?? output?.organizationId,
        project,
      );
      const environmentId = environmentIdOf(
        olds?.environment ?? output?.environmentId ?? "",
      );
      const api = olds?.api ?? output?.api ?? "";
      const revision = olds?.revision ?? output?.revision ?? "";
      const debugsessionId = yield* toResourceId(
        id,
        olds?.debugsessionId,
        output?.debugsessionId,
        { maxLength: 63, rfc1035: true },
      );
      const name =
        output?.name ??
        sessionName(
          revisionParent(organizationId, environmentId, api, revision),
          debugsessionId,
        );
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        organizationId,
        environmentId,
        api,
        revision,
      );
      return output !== undefined || isAlchemySessionId(attrs.debugsessionId)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsApisRevisionsDebugsession["Attributes"][] = [];
        const orgs = Array.from(
          new Set(environments.map((item) => item.organizationId)),
        );
        const apis = yield* Effect.forEach(orgs, listOrgApis, {
          concurrency: 2,
        });
        const sessions = yield* Effect.forEach(
          apis.flat(),
          (proxy) =>
            proxy.name
              ? listApiSessions(proxy.name)
              : Effect.succeed(
                  [] as apigee.GoogleCloudApigeeV1ApiDebugSession[],
                ),
          { concurrency: 4 },
        );
        for (const [proxy, listed] of apis.flat().map((proxy, index) => {
          return [proxy, sessions[index] ?? []] as const;
        })) {
          const organizationId =
            segmentAfter(proxy.name ?? "", "organizations") ?? "";
          const api = lastSegment(proxy.name ?? "");
          for (const session of listed) {
            if (!isAlchemySessionId(session.id)) continue;
            const environmentId = session.environmentId ?? "";
            const revision = session.apiProxyRevisionId ?? "";
            const debugsessionId = session.id ?? "";
            found.push({
              name: sessionName(
                revisionParent(organizationId, environmentId, api, revision),
                debugsessionId,
              ),
              debugsessionId,
              organizationId,
              environmentId,
              api,
              revision,
              timeout: undefined,
              filter: undefined,
              validity: undefined,
              count: undefined,
              tracesize: undefined,
              createTime: session.createTime,
            });
          }
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const api = news.api;
      const revision = news.revision;
      const debugsessionId = yield* toResourceId(
        id,
        news.debugsessionId,
        output?.debugsessionId,
        { maxLength: 63, rfc1035: true },
      );
      const parent = revisionParent(
        organizationId,
        environmentId,
        api,
        revision,
      );
      const name = sessionName(parent, debugsessionId);

      let current = yield* getByName(output?.name ?? name);
      if (
        current !== undefined &&
        !sameText(lastSegment(current.name ?? ""), debugsessionId)
      ) {
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsApisRevisionsDebugsessions({
            parent,
            timeout: news.timeout,
            body: {
              name: debugsessionId,
              timeout: news.timeout,
              filter: news.filter,
              validity: news.validity,
              count: news.count,
              tracesize: news.tracesize,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsApisRevisionsDebugsessionNotResolved({
          name,
        });
      }

      return toAttrs(current, organizationId, environmentId, api, revision);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* apigee
        .deleteDataOrganizationsEnvironmentsApisRevisionsDebugsessions({
          name: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
