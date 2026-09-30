import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../../../IsolatedProject.ts";

/**
 * The isolated consumer project this container is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the container
 * bootstrap's own imports (`@effect/platform-bun`, `alchemy/*`, …) must be
 * anchored by the bundler.
 */
export const project = isolatedProject(
  "cloudflare-container",
  import.meta.filename,
);

/**
 * Minimal effectful `Cloudflare.Container` served from an isolated project.
 * `ping` (RPC) and `/hello` (HTTP over the container's port 3000) answering
 * prove the generated bootstrap booted — with its imports left external bun
 * dies at module load and the Durable Object's requests never get a reply.
 */
export class IsolatedContainer extends Cloudflare.Container<
  IsolatedContainer,
  { ping: () => Effect.Effect<string> }
>()("IsolatedProjectContainer") {}

export default IsolatedContainer.make(
  {
    main: project.main,
    image: "oven/bun:latest",
  },
  Effect.gen(function* () {
    return {
      ping: () => Effect.succeed("pong"),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("hello from isolated project");
      }),
    };
  }),
);
