import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsExecutables from "./VcsExecutables.ts";

const resolveWith = (paths: Partial<Record<"gh" | "glab" | "az", string>>, command: string) =>
  Effect.gen(function* () {
    const executables = yield* VcsExecutables.VcsExecutables;
    return yield* executables.resolve(command);
  }).pipe(
    Effect.provide(
      VcsExecutables.layer.pipe(
        Layer.provide(ServerSettings.layerTest({ sourceControlCliPaths: paths })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

describe("VcsExecutables.resolve", () => {
  it.effect("spawns the configured path instead of the command name", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ gh: "/opt/gh/bin/gh" }, "gh")).toBe("/opt/gh/bin/gh");
    }),
  );

  it.effect("expands a leading ~ so hand-typed home paths work", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ glab: "~/.local/bin/glab" }, "glab")).toBe(
        `${NodeOS.homedir()}/.local/bin/glab`,
      );
    }),
  );

  it.effect("falls back to PATH resolution when the override is blank", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ az: "   " }, "az")).toBe("az");
      expect(yield* resolveWith({}, "gh")).toBe("gh");
    }),
  );

  it.effect("leaves commands that are not configurable untouched", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ gh: "/opt/gh/bin/gh" }, "git")).toBe("git");
    }),
  );
});
