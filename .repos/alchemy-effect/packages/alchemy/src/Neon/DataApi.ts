import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Input } from "../Input.ts";
import {
  authPlanScope,
  authRequest,
  authSettingsMatch,
  removedAuthSettings,
} from "./Auth.ts";
import { resolveBranchScope, type ResolvedBranchScope } from "./BranchScope.ts";
import type { Providers } from "./Providers.ts";

export type DataApiProps = (
  | {
      /** Branch resource or explicit identity, optionally carrying its selected database. */
      branch: { projectId: string; branchId: string; databaseName?: string };
      project?: never;
    }
  | {
      /** Project resource or explicit identity; selects the observed default branch. */
      project: { projectId: string; databaseName?: string };
      branch?: never;
    }
) & {
  /** Database served by PostgREST. Infers the referenced resource's selected database, or the branch's only database; required when ambiguous. */
  database?: string;
  /** Authentication mechanism. Changes replace the Data API. */
  authProvider?: "neon_auth" | "external";
  /** HTTPS JWKS endpoint required for external authentication. */
  jwksUrl?: string;
  /** Display name for an external authentication provider. */
  providerName?: string;
  /** Expected JWT audience. Neon still accepts tokens without an audience. */
  jwtAudience?: string;
  /** Opt in to public-schema table grants. Defaults to false. */
  addDefaultGrants?: boolean;
  /** Skip creating the auth schema and RLS helpers. */
  skipAuthSchema?: boolean;
  /** Explicitly owned PostgREST settings. Removing previously managed fields requires an explicit reset value. */
  settings?: Neon.DataAPISettings;
};

export interface DataApiAttributes {
  /** Neon project identity. */
  projectId: string;
  /** Branch identity. */
  branchId: string;
  /** Database served by this endpoint. */
  database: string;
  /** Public PostgREST base URL. Requests must carry end-user authorization. */
  url: string;
  /** Observed deployment status. */
  status: string;
  /** Observed PostgREST settings, if exposed by the backend. */
  settings: Neon.DataAPISettings | undefined;
}

export interface DataApi extends Resource<
  "Neon.DataApi",
  DataApiProps,
  DataApiAttributes,
  never,
  Providers
> {}

/**
 * Own a branch/database Data API singleton. This resource never grants an
 * application the account deployment key. Configure RLS and forward the user's
 * token through QueryDataApi. Authentication inputs are creation-only because
 * the API only supports updating PostgREST settings.
 *
 * ### Expose a database through managed authentication
 * **Example:** Managed Auth and PostgREST
 * ```typescript
 * const dataApi = yield* Neon.DataApi("Data", {
 *   branch, authProvider: "neon_auth", settings: { db_max_rows: 100 },
 * });
 * ```
 *
 * @resource
 * @product Data API
 */
export const DataApi = Resource<DataApi>("Neon.DataApi");

export class InvalidDataApiConfiguration extends Data.TaggedError(
  "InvalidDataApiConfiguration",
)<{
  message: string;
}> {}

const observe = (scope: {
  projectId: string;
  branchId: string;
  database: string;
}) =>
  Neon.getProjectBranchDataAPI({
    ...authRequest(scope),
    database_name: scope.database,
  }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const attributes = (
  scope: { projectId: string; branchId: string; database: string },
  observed: Neon.DataAPIReponse,
): DataApiAttributes => ({
  projectId: scope.projectId,
  branchId: scope.branchId,
  database: scope.database,
  url: observed.url,
  status: observed.status,
  settings: observed.settings ?? undefined,
});

const immutable = [
  "authProvider",
  "jwksUrl",
  "providerName",
  "jwtAudience",
  "addDefaultGrants",
  "skipAuthSchema",
] as const;

const validateDataApi = (news: DataApiProps) =>
  news.authProvider === "external" && !news.jwksUrl
    ? Effect.fail(
        new InvalidDataApiConfiguration({
          message: "External authentication requires jwksUrl",
        }),
      )
    : Effect.void;

const validateDataApiRemoval = (
  olds: DataApiProps | undefined,
  news: Input<DataApiProps>,
) => {
  const removed = removedAuthSettings(olds, news, [...immutable, "settings"]);
  return removed.length === 0
    ? Effect.void
    : Effect.fail(
        new InvalidDataApiConfiguration({
          message: `Cannot remove managed Data API settings: ${removed.join(", ")}; set explicit reset values instead`,
        }),
      );
};

const resolveDatabase = Effect.fn(function* (
  news: DataApiProps,
  scope: ResolvedBranchScope,
) {
  const database = news.database ?? (news.branch ?? news.project)?.databaseName;
  if (database !== undefined) {
    if (!database)
      return yield* new InvalidDataApiConfiguration({
        message: "database must not be empty",
      });
    return database;
  }
  const { databases } = yield* Neon.listProjectBranchDatabases(
    authRequest(scope),
  );
  if (databases.length !== 1) {
    return yield* new InvalidDataApiConfiguration({
      message:
        "Set database explicitly when the branch has no unambiguous selected database",
    });
  }
  return databases[0]!.name;
});

export const DataApiProvider = () =>
  Provider.succeed(DataApi, {
    stables: ["projectId", "branchId", "database"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      yield* validateDataApiRemoval(olds, news);
      if (isResolved(news)) yield* validateDataApi(news);
      const scope = yield* authPlanScope(news);
      if (
        output &&
        (!scope ||
          scope.projectId !== output.projectId ||
          scope.branchId !== output.branchId)
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return;
      const resolved = scope ?? (yield* resolveBranchScope(news));
      const database = yield* resolveDatabase(news, resolved);
      const previous = output ?? (yield* resolveBranchScope(olds));
      if (
        resolved.projectId !== previous.projectId ||
        resolved.branchId !== previous.branchId ||
        database !==
          (output?.database ?? (yield* resolveDatabase(olds, previous))) ||
        immutable.some((key) => news[key] !== olds[key])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (output) {
        const current = yield* observe({ ...resolved, database });
        if (
          !current ||
          (news.settings !== undefined &&
            !authSettingsMatch(current.settings ?? {}, news.settings))
        )
          return { action: "update" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (
        !output &&
        !(olds?.branch?.projectId && olds.branch.branchId) &&
        !olds?.project?.projectId
      )
        return undefined;
      const branch = output ?? (yield* resolveBranchScope(olds));
      const scope = output ?? {
        ...branch,
        database: yield* resolveDatabase(olds, branch),
      };
      const current = yield* observe(scope);
      if (!current) return undefined;
      const attrs = attributes(scope, current);
      return output ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news, output, olds }) {
      yield* validateDataApiRemoval(olds, news);
      yield* validateDataApi(news);
      const branch = yield* resolveBranchScope(news);
      const scope = {
        ...branch,
        database: yield* resolveDatabase(news, branch),
      };
      if (
        output &&
        (scope.projectId !== output.projectId ||
          scope.branchId !== output.branchId ||
          scope.database !== output.database)
      ) {
        return yield* new InvalidDataApiConfiguration({
          message:
            "Data API identity changed without replacement; refusing to mutate either endpoint",
        });
      }
      const request = { ...authRequest(scope), database_name: scope.database };
      let current = yield* observe(scope);
      if (current && !output)
        return yield* new OwnedBySomeoneElse({
          message: "Existing Data API requires explicit adoption",
          resourceType: "Neon.DataApi",
        });
      if (
        current &&
        olds === undefined &&
        immutable.some((key) => news[key] !== undefined)
      ) {
        return yield* new InvalidDataApiConfiguration({
          message:
            "Neon does not expose existing Data API authentication settings; adopt without creation-only settings, then replace to configure authentication",
        });
      }
      if (!current) {
        yield* Neon.createProjectBranchDataAPI({
          ...request,
          auth_provider: news.authProvider,
          jwks_url: news.jwksUrl,
          provider_name: news.providerName,
          jwt_audience: news.jwtAudience,
          add_default_grants: news.addDefaultGrants ?? false,
          skip_auth_schema: news.skipAuthSchema,
          settings: news.settings,
        }).pipe(
          Effect.catchTag("Conflict", () =>
            Effect.fail(
              new OwnedBySomeoneElse({
                message:
                  "Data API appeared during creation; explicit adoption is required",
                resourceType: "Neon.DataApi",
              }),
            ),
          ),
        );
        current = yield* Neon.getProjectBranchDataAPI(request);
      }
      if (
        news.settings !== undefined &&
        !authSettingsMatch(current.settings ?? {}, news.settings)
      ) {
        yield* Neon.updateProjectBranchDataAPI({
          ...request,
          settings: news.settings,
        });
      }
      return attributes(scope, yield* Neon.getProjectBranchDataAPI(request));
    }),
    delete: Effect.fn(function* ({ output }) {
      if (yield* observe(output)) {
        yield* Neon.deleteProjectBranchDataAPI({
          ...authRequest(output),
          database_name: output.database,
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    }),
  });
