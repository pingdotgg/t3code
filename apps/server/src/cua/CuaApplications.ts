import * as NodeModule from "node:module";
import { CuaApplication, CuaApplicationsError } from "@t3tools/contracts";
import type * as CuaSdk from "@trycua/cua-driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CuaDriver from "./CuaDriver.ts";

export type Sdk = Pick<typeof CuaSdk, "CuaDriver" | "ListAppsInput">;
type Client = Pick<CuaSdk.CuaDriver, "listApps" | "shutdown" | "uniffiDestroy">;
const isApplication = Schema.is(CuaApplication);
const requireSdk = NodeModule.createRequire(import.meta.url);
const loadSdk = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const root of requireSdk.resolve.paths("@trycua/cua-driver") ?? []) {
    const dir = path.join(root, "@trycua", "cua-driver");
    if (yield* fs.exists(path.join(dir, "package.json"))) {
      return yield* Effect.try(() => requireSdk(path.join(dir, "dist", "index.js")) as Sdk);
    }
  }
  return yield* new CuaApplicationsError({ cause: "Cua Driver SDK is not installed." });
}).pipe(Effect.mapError((cause) => new CuaApplicationsError({ cause })));

export class CuaApplications extends Context.Service<
  CuaApplications,
  {
    readonly list: Effect.Effect<ReadonlyArray<CuaApplication>, CuaApplicationsError>;
  }
>()("t3/cua/CuaApplications") {}

export const make = Effect.fn("CuaApplications.make")(function* (
  options: { loadSdk?: Effect.Effect<Sdk, CuaApplicationsError> } = {},
) {
  const driver = yield* CuaDriver.CuaDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sdk =
    options.loadSdk ??
    loadSdk.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const list = Effect.gen(function* () {
    if (!(yield* driver.enabled)) return [];
    const config = yield* driver.acquire;
    if (Option.isNone(config) || !config.value.socketPath) return [];
    const module = yield* sdk;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* Effect.acquireRelease(
          Effect.try(() => module.CuaDriver.connect(config.value.socketPath!) as unknown as Client),
          (client) =>
            Effect.promise(() => client.shutdown()).pipe(
              Effect.ignore,
              Effect.andThen(Effect.sync(() => client.uniffiDestroy())),
            ),
        );
        const result = yield* Effect.tryPromise((signal) =>
          client.listApps(module.ListAppsInput.new({}), { signal }),
        );
        const apps: CuaApplication[] = [];
        const seen = new Set<string>();
        for (const app of result.apps) {
          const packagedId = /^shell:appsFolder\\(.+)$/iu.exec(app.launchPath ?? "")?.[1];
          const bundleId =
            packagedId ??
            (app.bundleId && /^[A-Za-z0-9._-]+(?:![A-Za-z0-9._-]+)?$/u.test(app.bundleId)
              ? app.bundleId
              : undefined);
          const candidate = {
            name: app.name,
            ...(bundleId ? { bundleId } : {}),
            ...(app.launchPath ? { launchPath: app.launchPath } : {}),
            ...(app.running && app.pid > 0 ? { pid: app.pid } : {}),
          };
          if (!isApplication(candidate)) continue;
          const key = bundleId ?? app.launchPath ?? app.name;
          if (seen.has(key)) continue;
          seen.add(key);
          apps.push(candidate);
        }
        return apps.sort((a, b) => a.name.localeCompare(b.name));
      }),
    );
  }).pipe(Effect.mapError((cause) => new CuaApplicationsError({ cause })));
  return CuaApplications.of({ list });
});

export const layer = Layer.effect(CuaApplications, make());
