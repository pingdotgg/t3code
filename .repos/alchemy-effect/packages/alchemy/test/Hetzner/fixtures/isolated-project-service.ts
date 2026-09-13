import * as Hetzner from "@/Hetzner";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../IsolatedProject.ts";

/**
 * The isolated consumer project this service is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the bun
 * bootstrap's own imports must be anchored by the bundler.
 */
export const project = isolatedProject("hetzner-service", import.meta.filename);

export const IsolatedBox = Hetzner.Server("IsolatedProjectBox", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "nbg1",
});

/**
 * Minimal `Hetzner.Service` served from an isolated project. `/health`
 * answering 200 proves the generated bootstrap booted under its systemd
 * unit — with its imports left external bun dies at module load and the
 * port never answers.
 */
export default class IsolatedProjectApi extends Hetzner.Service<IsolatedProjectApi>()(
  "IsolatedProjectApi",
  {
    server: IsolatedBox,
    main: project.main,
    port: 3000,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("hello from isolated project");
      }),
    };
  }),
) {}
