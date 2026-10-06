import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { detectBrowsers } from "./BrowserTabs.ts";

const profile = Effect.fn("test.browserProfile")(function* (
  root: string,
  relative: string,
  port?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, ...relative.split("/"));
  yield* fs.makeDirectory(dir, { recursive: true });
  if (port !== undefined)
    yield* fs.writeFileString(path.join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/x`);
  return dir;
});

it.layer(NodeServices.layer)("detectBrowsers", (it) => {
  it.effect.each([
    {
      platform: "darwin" as const,
      env: (root: string) => ({ HOME: root }),
      chrome: "Library/Application Support/Google/Chrome",
      edge: "Library/Application Support/Microsoft Edge",
    },
    {
      platform: "linux" as const,
      env: (root: string) => ({ HOME: "/nonexistent", XDG_CONFIG_HOME: root }),
      chrome: "google-chrome",
      edge: "microsoft-edge",
    },
    {
      platform: "win32" as const,
      env: (root: string) => ({ LOCALAPPDATA: root }),
      chrome: "Google/Chrome/User Data",
      edge: "Microsoft/Edge/User Data",
    },
  ])("finds $platform profiles, the one with remote debugging on first", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-tabs-" });
      yield* profile(root, testCase.chrome);
      const edgeDir = yield* profile(root, testCase.edge, 9222);

      const browsers = yield* detectBrowsers().pipe(
        Effect.provideService(HostProcessPlatform, testCase.platform),
        Effect.provideService(HostProcessEnvironment, testCase.env(root)),
      );

      expect(browsers.map(({ id, remoteDebugging }) => ({ id, remoteDebugging }))).toEqual([
        { id: "edge", remoteDebugging: true },
        { id: "chrome", remoteDebugging: false },
      ]);
      expect(browsers[0]?.userDataDir).toBe(edgeDir);
      expect(browsers[0]?.inspectUrl).toBe("edge://inspect/#remote-debugging");
    }).pipe(Effect.scoped),
  );
});
