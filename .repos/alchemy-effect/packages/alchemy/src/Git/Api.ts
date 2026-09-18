/**
 * The typed HTTP contract for git-service (DESIGN.md §5): every plane as
 * one Effect `HttpApi`, so the Worker, the clients
 * (`HttpApiClient.make(GitApi, ...)`), and OpenAPI share one schema-checked
 * surface.
 *
 * Endpoints use `HttpApiEndpoint`; groups are implemented with
 * `HttpApiBuilder.group`. The exported groups can also form a smaller API.
 *
 * | Group | Path | Routes |
 * | --- | --- | --- |
 * | {@link Repos} | `/api/v1/repos` | create, get, update, list, delete, fork, import, compact |
 * | {@link Refs} | `/api/v1/repos/:owner/:repo/ref(s)` | list, get, update, remove |
 * | {@link Objects} | `/api/v1/repos/:owner/:repo/…` | commit, log, tree, blob, diff, compare, blobRaw, file |
 * | {@link Pulls} | `/api/v1/repos/:owner/:repo/pulls` | create, list, get, update, merge |
 * | {@link Protocol} | `/:owner/:repo/…` | infoRefs, uploadPack, receivePack |
 * | {@link GitHub} | `/api/v3` | the GitHub REST v3 facade |
 *
 * No route carries middleware: apply application HttpRouter middleware to
 * Git.ApiLive when composing the public routes. The engine's own hash route is
 * {@link InternalApi}, mounted separately. Shared schemas and tagged
 * errors live in `Api/Schema.ts` and are re-exported flatly from here.
 */
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { GitHub } from "./Api/GitHub.ts";
import { Objects } from "./Api/Objects.ts";
import { Protocol } from "./Api/Protocol.ts";
import { Pulls } from "./Api/Pulls.ts";
import { Refs } from "./Api/Refs.ts";
import { Repos } from "./Api/Repos.ts";

export * from "./Api/Schema.ts";
export * from "./Api/GitHub.ts";
export * from "./Api/Internal.ts";
export * from "./Api/Objects.ts";
export * from "./Api/Protocol.ts";
export * from "./Api/Pulls.ts";
export * from "./Api/Refs.ts";
export * from "./Api/Repos.ts";

/**
 * The complete git-service API: the REST plane at `/api/v1`, the git wire
 * protocol at the root, and the GitHub facade at `/api/v3`. Compose client
 * schemas with `AppApi.addHttpApi(Git.Api)`, or build one from the groups.
 */
export class GitApi extends HttpApi.make("git-service")
  .add(Repos)
  .add(Refs)
  .add(Objects)
  .add(Pulls)
  .add(Protocol)
  .add(GitHub) {}

/**
 * Whether a request to one of the engine's routes only reads: the REST
 * and raw reads, the GitHub facade's `GET`s, the ref advertisement for a
 * fetch, and `git-upload-pack`. The advertisement for a push
 * (`info/refs?service=git-receive-pack`) is not a read. A middleware that
 * lets anonymous callers read public repositories asks this.
 *
 * ```typescript
 * (httpEffect) =>
 *   Effect.gen(function* () {
 *     const request = yield* HttpServerRequest.HttpServerRequest;
 *     if (Git.isRead(request) && (yield* isPublic)) return yield* httpEffect;
 *     // …
 *   })
 * ```
 */
export const isRead = (
  request: HttpServerRequest.HttpServerRequest,
): boolean => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "POST")
    return url.pathname.endsWith("/git-upload-pack");
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return (
    !url.pathname.endsWith("/info/refs") ||
    url.searchParams.get("service") !== "git-receive-pack"
  );
};
