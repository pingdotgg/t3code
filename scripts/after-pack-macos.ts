import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import Plist, { type PlistObject } from "plist";

// The backend runs as the generic Helper, so macOS shows that bundle's usage strings in privacy
// prompts that agent commands trigger. electron-builder only extends the main Info.plist.
const copyUsageDescriptionsToHelper = Effect.fn("afterPackMacos.copyUsageDescriptionsToHelper")(
  function* (appOutDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const apps = (yield* fs.readDirectory(appOutDir)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) {
      return yield* Effect.die(
        new Error(`Expected one app bundle in ${appOutDir}, found ${apps.length}.`),
      );
    }
    const contents = path.join(appOutDir, apps[0]!, "Contents");
    const main = Plist.parse(
      yield* fs.readFileString(path.join(contents, "Info.plist")),
    ) as PlistObject;
    const executable = main.CFBundleExecutable;
    if (typeof executable !== "string") {
      return yield* Effect.die(new Error(`${apps[0]} has no CFBundleExecutable.`));
    }
    const helperPlistPath = path.join(
      contents,
      "Frameworks",
      `${executable} Helper.app`,
      "Contents",
      "Info.plist",
    );
    const helper = Plist.parse(yield* fs.readFileString(helperPlistPath)) as PlistObject;
    const usageDescriptions = Object.entries(main).filter(([key]) =>
      /^NS\w+UsageDescription$/.test(key),
    );
    yield* fs.writeFileString(
      helperPlistPath,
      Plist.build({ ...helper, ...Object.fromEntries(usageDescriptions) }),
    );
  },
);

export default function afterPack(context: {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
}): Promise<void> {
  if (context.electronPlatformName !== "darwin") return Promise.resolve();
  return Effect.runPromise(
    copyUsageDescriptionsToHelper(context.appOutDir).pipe(Effect.provide(NodeServices.layer)),
  );
}
