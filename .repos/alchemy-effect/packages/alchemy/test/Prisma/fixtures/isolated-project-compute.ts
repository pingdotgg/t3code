// Deep imports keep the Compute bundle lean (see ./bucket.ts).
import { Compute } from "@/Prisma/Compute.ts";
import { Project } from "@/Prisma/Project.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../IsolatedProject.ts";

/**
 * The isolated consumer project this app is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the bun
 * bootstrap's own imports must be anchored by the bundler.
 */
export const project = isolatedProject("prisma-compute", import.meta.filename);

export const IsolatedProjectPrismaProject = Project(
  "PrismaIsolatedProjectProject",
  {
    name: "alchemy-isolated-project",
    createDatabase: false,
  },
);

/**
 * Minimal Effect-native `Prisma.Compute` app served from an isolated
 * project. `/health` answering 200 proves the generated bootstrap booted —
 * with its imports left external bun dies at module load and the deployment
 * never becomes reachable.
 */
export default Compute(
  "PrismaIsolatedProjectCompute",
  Effect.gen(function* () {
    const prismaProject = yield* IsolatedProjectPrismaProject;
    return {
      project: prismaProject,
      appName: "alchemy-isolated-project",
      main: project.main,
      port: 8080,
      timeoutSeconds: 240,
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://app");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("hello from isolated project");
      }),
    };
  }),
);
