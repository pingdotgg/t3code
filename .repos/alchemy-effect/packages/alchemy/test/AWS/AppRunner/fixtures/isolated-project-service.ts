import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../../IsolatedProject.ts";

/**
 * The isolated consumer project this service is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the bun
 * bootstrap's own imports must be anchored by the bundler.
 */
export const project = isolatedProject(
  "apprunner-service",
  import.meta.filename,
);

/**
 * Minimal Effect-native `AWS.AppRunner.Service` served from an isolated
 * project. `/health` answering 200 proves the generated bootstrap booted —
 * with its imports left external the container dies at module load and App
 * Runner never reaches RUNNING.
 */
export default class IsolatedProjectService extends AWS.AppRunner.Service<IsolatedProjectService>()(
  "AppRunnerIsolatedProjectService",
  {
    main: project.main,
    serviceName: "alchemy-test-apprunner-isolated-project",
    port: 3000,
    instanceConfiguration: { cpu: "256", memory: "512" },
    healthCheckConfiguration: { protocol: "HTTP", path: "/health" },
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // aggressively rate-limits anonymous pulls (429) during local builds.
    docker: { base: "oven/bun:1" },
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
