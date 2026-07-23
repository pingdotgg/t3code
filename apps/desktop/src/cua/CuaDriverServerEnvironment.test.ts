import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
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
