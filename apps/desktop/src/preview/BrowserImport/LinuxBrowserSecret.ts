import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";

/** Absolute path to the helper shipped with this desktop instance. */
export const LinuxBrowserSecretPath = Context.Reference<string | undefined>(
  "@t3tools/desktop/preview/BrowserImport/LinuxBrowserSecretPath",
  { defaultValue: () => undefined },
);

export const layer = Layer.effect(
  LinuxBrowserSecretPath,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    if (environment.platform !== "linux") return undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const relative = environment.path.join("browser-secret", "t3-browser-secret");
    const candidates = environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, relative)]
      : [
          environment.path.join(
            environment.rootDir,
            "native",
            "browser-secret",
            "build",
            environment.processArch,
            "t3-browser-secret",
          ),
          ...environment.resolveResourcePathCandidates(relative),
        ];
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
        return candidate;
    }
    return undefined;
  }),
);
