import * as NodeServices from "@effect/platform-node/NodeServices";
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import Plist, { type PlistObject } from "plist";

/** Entitlements file for the generic Helper, which runs the backend and its agent commands. */
export const MAC_BACKEND_HELPER_ENTITLEMENTS_ENV = "T3CODE_MAC_BACKEND_HELPER_ENTITLEMENTS";

export const withBackendHelperEntitlements = Effect.fn("signMacos.withBackendHelperEntitlements")(
  function* (options: SignOptions, entitlements: string | undefined) {
    if (!entitlements) return options;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const app = path.resolve(options.app);
    const info = Plist.parse(
      yield* fs.readFileString(path.join(app, "Contents", "Info.plist")),
    ) as PlistObject;
    const executable = info.CFBundleExecutable;
    if (typeof executable !== "string") {
      return yield* Effect.die(new Error(`${app} has no CFBundleExecutable.`));
    }
    // Electron and electron-builder name the generic helper after the main executable.
    const helperApp = path.join(app, "Contents", "Frameworks", `${executable} Helper.app`);
    const helperFiles = new Set([
      helperApp,
      path.join(helperApp, "Contents", "MacOS", `${executable} Helper`),
    ]);
    const { optionsForFile } = options;
    return {
      ...options,
      optionsForFile: (filePath, context) => {
        const fileOptions = optionsForFile?.(filePath, context) ?? {};
        return helperFiles.has(filePath) ? { ...fileOptions, entitlements } : fileOptions;
      },
    } satisfies SignOptions;
  },
);

export default async function sign(options: SignOptions): Promise<void> {
  const signOptions = await Effect.runPromise(
    withBackendHelperEntitlements(options, process.env[MAC_BACKEND_HELPER_ENTITLEMENTS_ENV]).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  await signApplication({ ...signOptions, batchCodesignCalls: true });
}
