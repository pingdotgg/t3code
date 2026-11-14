import { fileURLToPath } from "node:url";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";

const workerMain = fileURLToPath(new URL("./worker.ts", import.meta.url));

export const applications = (maxInstances = 2, name?: string) =>
  Effect.gen(function* () {
    const owned = yield* Cloudflare.Container("CachedIdentity", {
      name,
      image: "mendhak/http-https-echo:41",
      maxInstances,
    }).Application;
    const other = yield* Cloudflare.Container("OtherIdentity", {
      image: "mendhak/http-https-echo:41",
      maxInstances: 3,
    }).Application;
    return { owned, other };
  });

/**
 * An application and a Worker that reference each other, so the application
 * is precreated. The Worker's name keeps the application's props unresolved.
 */
export const cyclicApplication = (name: string, scoped?: boolean) =>
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("CyclicWorker", {
      main: workerMain,
      workersDev: false,
    });
    const declaration = Cloudflare.Container("CyclicDifferent", {
      name,
      image: "mendhak/http-https-echo:41",
      maxInstances: 1,
      env: { WORKER_NAME: worker.workerName },
    }).Application;
    const app = yield* scoped === undefined ? declaration : declaration.pipe(adopt(scoped));
    yield* worker.bind`APP_NAME`({
      bindings: [{ type: "plain_text", name: "APP_NAME", text: app.applicationName }],
    });
    return app;
  });
