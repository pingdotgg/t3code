import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";

const readOwnerWithRuntimeFile = (contents: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-home-owner-" });
    if (contents !== undefined) {
      yield* fs.makeDirectory(`${home}/userdata`, { recursive: true });
      yield* fs.writeFileString(`${home}/userdata/server-runtime.json`, contents);
    }
    return yield* DesktopHomeOwner.readLiveHomeOwner().pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: home,
          platform: "linux",
          processArch: "x64",
          appVersion: "0.0.0",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: home })),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

describe("DesktopHomeOwner.readLiveHomeOwner", () => {
  it.effect("reports a live server recorded in server-runtime.json", () =>
    Effect.gen(function* () {
      const owner = yield* readOwnerWithRuntimeFile(
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3790,
          origin: "http://127.0.0.1:3790",
          startedAt: "2026-01-01T00:00:00.000Z",
          serverVersion: "1.2.3",
        }),
      );
      assert.deepStrictEqual(
        owner,
        Option.some({ pid: process.pid, port: 3790, serverVersion: "1.2.3" }),
      );
      assert.include(
        DesktopHomeOwner.homeOwnedMessage(owner),
        `PID ${process.pid}, port 3790, version 1.2.3`,
      );
    }),
  );

  it.effect("ignores a missing, malformed or dead owner record", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* readOwnerWithRuntimeFile(undefined)));
      assert.isTrue(Option.isNone(yield* readOwnerWithRuntimeFile("{not json")));
      assert.isTrue(
        Option.isNone(yield* readOwnerWithRuntimeFile(JSON.stringify({ pid: 0, port: 3790 }))),
      );
    }),
  );
});
