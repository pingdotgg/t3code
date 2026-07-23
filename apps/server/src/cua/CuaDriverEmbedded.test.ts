import { describe, expect, it } from "vite-plus/test";

import * as Effect from "effect/Effect";

import type { EmbeddedDriverExit } from "@trycua/cua-driver/embedded";

import {
  buildCodexLaunchArgs,
  installCodexLaunchArgs,
  monitorEmbeddedCuaDriverExit,
  T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV,
} from "./CuaDriverEmbedded.ts";

const connection = {
  mcp: {
    command: "/Applications/T3 Code/cua-driver",
    args: ["mcp", "--embedded", "--socket", "/tmp/t3 code.sock"],
    environment: [
      { name: "CUA_DRIVER_EMBEDDED", value: "1" },
      { name: "CUA_DRIVER_HOST_BUNDLE_ID", value: "com.t3tools.t3code" },
    ],
  },
};

describe("embedded cua-driver Codex configuration", () => {
  it("quotes MCP launch arguments", () => {
    expect(buildCodexLaunchArgs(connection)).toBe(
      '-c "mcp_servers.cua-driver.command=\\"/Applications/T3 Code/cua-driver\\"" -c "mcp_servers.cua-driver.args=[\\"mcp\\",\\"--embedded\\",\\"--socket\\",\\"/tmp/t3 code.sock\\"]" -c "mcp_servers.cua-driver.env={CUA_DRIVER_EMBEDDED=\\"1\\",CUA_DRIVER_HOST_BUNDLE_ID=\\"com.t3tools.t3code\\"}"',
    );
  });

  it("reports every unexpected driver exit regardless of its status", async () => {
    const exits: ReadonlyArray<EmbeddedDriverExit> = [
      { generation: "generation-1", code: 9, success: false },
      { generation: "generation-2", code: 0, success: true },
    ];
    const observed: Array<EmbeddedDriverExit> = [];

    for (const exit of exits) {
      await Effect.runPromise(
        monitorEmbeddedCuaDriverExit(
          () => Promise.resolve(exit),
          (value) =>
            Effect.sync(() => {
              observed.push(value);
            }),
        ),
      );
    }

    expect(observed).toEqual(exits);
  });

  it("does not report an exit when its scope shuts down", async () => {
    let reported = false;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* monitorEmbeddedCuaDriverExit(
            () => new Promise<EmbeddedDriverExit>(() => {}),
            () =>
              Effect.sync(() => {
                reported = true;
              }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
        }),
      ),
    );

    expect(reported).toBe(false);
  });

  it("restores prior Codex launch arguments once when Cua becomes unavailable", async () => {
    const original = process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV];
    process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV] = "--existing";
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const deactivate = yield* installCodexLaunchArgs("--cua");
            expect(process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV]).toBe("--existing --cua");
            expect(yield* deactivate()).toBe(true);
            expect(process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV]).toBe("--existing");
            expect(yield* deactivate()).toBe(false);
          }),
        ),
      );
      expect(process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV]).toBe("--existing");
    } finally {
      if (original === undefined) delete process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV];
      else process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV] = original;
    }
  });
});
