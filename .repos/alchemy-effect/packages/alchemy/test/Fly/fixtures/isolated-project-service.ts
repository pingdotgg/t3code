import * as Fly from "@/Fly";
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
export const project = isolatedProject("fly-service", import.meta.filename);

export const IsolatedSite = Fly.App("IsolatedProjectSite", {
  enableSubdomains: true,
});

/**
 * Minimal `Fly.Service` served from an isolated project. `/health`
 * answering 200 proves the generated bootstrap booted on the Machine — with
 * its imports left external bun dies at module load and the app never
 * answers.
 */
export default class IsolatedProjectApi extends Fly.Service<IsolatedProjectApi>()(
  "IsolatedProjectApi",
  {
    app: IsolatedSite,
    main: project.main,
    region: "iad",
    port: 3000,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
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
