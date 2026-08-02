import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  configureCuaDriverServerEnvironment,
  CuaDriverNotConfiguredError,
  disableCuaDriverServerEnvironment,
  resolveEmbeddedDriverPath,
  T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV,
  T3CODE_CUA_DRIVER_MODULE_URL_ENV,
  T3CODE_CUA_DRIVER_PATH_ENV,
} from "./CuaDriverServerEnvironment.ts";

describe("cua-driver server environment", () => {
  it("uses a configured driver path", () => {
    expect(
      Option.getOrUndefined(
        resolveEmbeddedDriverPath({ T3CODE_CUA_DRIVER_PATH: "/Applications/T3 Code/cua-driver" }),
      ),
    ).toBe("/Applications/T3 Code/cua-driver");
  });

  it("uses the packaged resource when no override is configured", () => {
    expect(
      Option.getOrUndefined(
        resolveEmbeddedDriverPath({}, "/Applications/T3 Code.app/Contents/Resources/cua-driver"),
      ),
    ).toBe("/Applications/T3 Code.app/Contents/Resources/cua-driver");
  });

  it("ignores the development override in packaged builds", () => {
    expect(
      Option.getOrUndefined(
        resolveEmbeddedDriverPath(
          { T3CODE_CUA_DRIVER_PATH: "/tmp/untrusted-cua-driver" },
          "/Applications/T3 Code.app/Contents/Resources/cua-driver",
        ),
      ),
    ).toBe("/Applications/T3 Code.app/Contents/Resources/cua-driver");
  });

  it("ignores missing and empty paths", () => {
    expect(Option.isNone(resolveEmbeddedDriverPath({}))).toBe(true);
    expect(Option.isNone(resolveEmbeddedDriverPath({ T3CODE_CUA_DRIVER_PATH: "  " }))).toBe(true);
  });

  it.effect("reports missing configuration without a fabricated path", () => {
    const previous = process.env[T3CODE_CUA_DRIVER_PATH_ENV];
    delete process.env[T3CODE_CUA_DRIVER_PATH_ENV];
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[T3CODE_CUA_DRIVER_PATH_ENV];
            else process.env[T3CODE_CUA_DRIVER_PATH_ENV] = previous;
          }),
        );
        const error = yield* configureCuaDriverServerEnvironment(
          "com.t3tools.t3code",
          "linux",
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(CuaDriverNotConfiguredError);
      }),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("loads the packaged module from the asar archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resourcesPath = "/Applications/T3 Code.app/Contents/Resources";
        yield* configureCuaDriverServerEnvironment("com.t3tools.t3code", "darwin", resourcesPath);

        const moduleUrl = yield* path.toFileUrl(
          path.join(resourcesPath, "app.asar/node_modules/@trycua/cua-driver/dist/embedded.js"),
        );
        expect(process.env[T3CODE_CUA_DRIVER_MODULE_URL_ENV]).toBe(moduleUrl.href);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses packaged executables outside macOS", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resourcesPath = "/opt/T3 Code/resources";
        for (const [platform, executable] of [
          ["linux", "cua-driver"],
          ["win32", "cua-driver.exe"],
        ] as const) {
          yield* configureCuaDriverServerEnvironment("com.t3tools.t3code", platform, resourcesPath);
          expect(process.env[T3CODE_CUA_DRIVER_PATH_ENV]).toBe(
            path.join(resourcesPath, "cua-driver", executable),
          );
          expect(process.env[T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV]).toBe("com.t3tools.t3code");
          expect(process.env[T3CODE_CUA_DRIVER_MODULE_URL_ENV]).toContain(
            "app.asar/node_modules/@trycua/cua-driver/dist/embedded.js",
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prevents inherited configuration from bypassing the desktop opt-in", () => {
    const names = [
      T3CODE_CUA_DRIVER_PATH_ENV,
      T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV,
      T3CODE_CUA_DRIVER_MODULE_URL_ENV,
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]] as const));
    for (const name of names) process.env[name] = `inherited-${name}`;

    return Effect.scoped(
      Effect.gen(function* () {
        yield* disableCuaDriverServerEnvironment();
        for (const name of names) expect(process.env[name]).toBeUndefined();
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const name of names) expect(process.env[name]).toBe(`inherited-${name}`);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          for (const name of names) {
            const value = previous[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }),
      ),
    );
  });
});
