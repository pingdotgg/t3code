import type { Config } from "@distilled.cloud/railway";
import { Credentials } from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

export class RailwayWorkspaceNotFound extends Data.TaggedError(
  "Railway.WorkspaceNotFound",
)<{
  message: string;
}> {}

/**
 * Default Railway workspace for the current token
 * (`me.workspace ?? me.workspaces[0]`). Not a resource — the Environment
 * *resource* is a project-scoped deploy environment.
 */
export type RailwayWorkspace = {
  readonly id: string;
  readonly name: string;
};

/**
 * Fully-resolved Railway environment for a stack.
 *
 * `{ token, tokenKind, apiBaseUrl }` comes from distilled `Credentials`.
 * `workspaceId` is the current token's default workspace
 * (`me.workspace ?? me.workspaces[0]`), cached for the process. Resolve
 * it inside lifecycle operations with `RailwayEnvironment.current`.
 */
export type RailwayEnvironmentShape = Config & {
  readonly workspaceId: string;
};

export class RailwayEnvironment extends Context.Service<
  RailwayEnvironment,
  Effect.Effect<RailwayEnvironmentShape>
>()("Railway::Environment") {
  static current = RailwayEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

/**
 * Discover the current token's default workspace.
 *
 * Personal account tokens answer `me.workspace ?? me.workspaces[0]`.
 * Workspace/team tokens reject `me` with {@link RailwayForbidden}
 * (`Not Authorized`); fall back to `apiToken.workspaces[0]`.
 */
export const resolveWorkspace = Effect.fn(function* () {
  const fromMe = yield* railway.me({}).pipe(
    Effect.map((me) => me.workspace ?? me.workspaces[0]),
    Effect.catchTag(["RailwayForbidden", "RailwayUnauthenticated"], () =>
      Effect.succeed(undefined),
    ),
  );
  if (fromMe !== undefined && fromMe.id.length > 0) {
    return {
      id: fromMe.id,
      name: fromMe.name,
    } satisfies RailwayWorkspace;
  }

  const token = yield* railway.apiToken({});
  const workspace = token.workspaces[0];
  if (workspace === undefined || workspace.id.length === 0) {
    return yield* new RailwayWorkspaceNotFound({
      message:
        "Railway current token did not include a workspace. Check RAILWAY_API_TOKEN is an account or workspace token.",
    });
  }
  return {
    id: workspace.id,
    name: workspace.name,
  } satisfies RailwayWorkspace;
});

/**
 * Current token workspace id (`me.workspace ?? me.workspaces[0]`).
 */
export const resolveWorkspaceId = Effect.fn(function* () {
  const workspace = yield* resolveWorkspace();
  return workspace.id;
});

/**
 * Build a `RailwayEnvironment` layer from the distilled `Credentials`
 * service. Provide this after `Credentials.fromAuthProvider()`.
 *
 * `workspaceId` is resolved from `me` and cached so Project.list /
 * Catalog do not re-hit `me` on every call.
 */
export const fromCredentials = () =>
  Layer.effect(
    RailwayEnvironment,
    Effect.gen(function* () {
      const creds = yield* Credentials;
      const http = yield* HttpClient.HttpClient;
      return yield* creds.pipe(
        Effect.flatMap((resolved) =>
          resolveWorkspaceId().pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(Credentials, creds),
                Layer.succeed(HttpClient.HttpClient, http),
              ),
            ),
            Effect.map((workspaceId) => ({
              ...resolved,
              workspaceId,
            })),
          ),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
