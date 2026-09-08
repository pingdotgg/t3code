import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../IsolatedProject.ts";

/**
 * The isolated consumer project this sprite is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the bun
 * bootstrap's own imports must be anchored by the bundler.
 */
export const project = isolatedProject("fly-sprite", import.meta.filename);

/**
 * Minimal `Fly.Sprite` served from an isolated project. `/health` answering
 * 200 proves the generated bootstrap booted — with its imports left external
 * bun dies at module load and the sprite URL never answers.
 */
export default class IsolatedProjectBox extends Fly.Sprite<IsolatedProjectBox>()(
  "IsolatedProjectBox",
  {
    main: project.main,
    urlAuth: "public",
    port: 3000,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://sprite");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }),
) {}
