// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import { parse } from "smol-toml";

import { resolveCodexCua } from "./resolveCodexCua.ts";

const descriptor = { command: "cua-driver", args: ["mcp", "--proxy"], environment: [] };

it.effect("does no config I/O or host startup while disabled", () =>
  resolveCodexCua(
    { enabled: Effect.succeed(false), acquire: Effect.die("unexpected host startup") },
    { cwd: "/project", homePath: "/codex-home", launchArgs: "" },
  ).pipe(
    Effect.provide(NodePathLayer.layer),
    Effect.map((args) => NodeAssert.deepEqual(args, [])),
    Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.die("unexpected I/O") })),
  ),
);

it.effect("explicit user launch configuration avoids reading files or starting a host", () =>
  resolveCodexCua(
    { enabled: Effect.succeed(true), acquire: Effect.die("unexpected host startup") },
    {
      cwd: "/project",
      homePath: "/codex-home",
      launchArgs: "-c 'mcp_servers.cua-driver.command=\"custom\"'",
    },
  ).pipe(
    Effect.provide(NodePathLayer.layer),
    Effect.map((args) => NodeAssert.deepEqual(args, [])),
    Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.die("unexpected I/O") })),
  ),
);

for (const location of ["home", "project", "parent", "malformed"] as const) {
  it.effect(`preserves ${location} Codex configuration without acquiring managed Cua`, () => {
    const home = NodePath.resolve("/custom-codex-home");
    const project = NodePath.resolve("/workspace/project");
    const selectedPath =
      location === "home" || location === "malformed"
        ? NodePath.join(home, "config.toml")
        : NodePath.join(
            location === "project" ? project : NodePath.dirname(project),
            ".codex",
            "config.toml",
          );
    return resolveCodexCua(
      { enabled: Effect.succeed(true), acquire: Effect.die("unexpected host startup") },
      { cwd: project, homePath: home, launchArgs: "", environment: { CODEX_HOME: "/wrong-home" } },
    ).pipe(
      Effect.provide(NodePathLayer.layer),
      Effect.map((args) => NodeAssert.deepEqual(args, [])),
      Effect.provide(
        FileSystem.layerNoop({
          readFileString: (path) =>
            Effect.succeed(
              path === selectedPath
                ? location === "malformed"
                  ? "not valid TOML"
                  : "[mcp_servers.cua-driver]\nenabled = false"
                : "",
            ),
        }),
      ),
    );
  });
}

it.effect("acquires once after reading the instance home and emits structured argv", () => {
  const paths: string[] = [];
  let acquired = 0;
  return resolveCodexCua(
    {
      enabled: Effect.succeed(true),
      acquire: Effect.sync(() => {
        acquired++;
        return Option.some(descriptor);
      }),
    },
    {
      cwd: "/workspace/project",
      homePath: "",
      environment: { CODEX_HOME: "/instance-home" },
      launchArgs: "",
    },
  ).pipe(
    Effect.provide(NodePathLayer.layer),
    Effect.map((args) => {
      NodeAssert.equal(acquired, 1);
      NodeAssert.equal(paths[0], NodePath.join("/instance-home", "config.toml"));
      NodeAssert.equal(args[0], "-c");
      NodeAssert.deepEqual(parse(args[1]!), {
        mcp_servers: {
          "cua-driver": { command: descriptor.command, args: descriptor.args, env: {} },
        },
      });
    }),
    Effect.provide(
      FileSystem.layerNoop({
        readFileString: (path) =>
          Effect.sync(() => {
            paths.push(path);
            return "";
          }),
      }),
    ),
  );
});
