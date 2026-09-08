import * as Docker from "@/Docker";
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
export const project = isolatedProject("docker-service", import.meta.filename);

/**
 * Fixed host port published through the swarm ingress. Deterministic and
 * distinct from the other Docker suites on the shared local daemon.
 */
export const SERVICE_EXTERNAL_PORT = 43119;

/**
 * Minimal effectful `Docker.Service` served from an isolated project.
 * `/health` answering 200 proves the generated bootstrap booted — with its
 * imports left external bun dies at module load and the swarm task
 * restart-loops without ever listening.
 */
export default class IsolatedProjectService extends Docker.Service<IsolatedProjectService>()(
  "DockerIsolatedProjectService",
  {
    main: project.main,
    port: 3000,
    ports: [{ external: SERVICE_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
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
