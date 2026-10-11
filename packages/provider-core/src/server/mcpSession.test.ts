import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makeMcpCredentialFiles,
  withAgentDeviceEnvironment,
  withoutRawMcpCredentials,
} from "./mcpSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("withoutRawMcpCredentials", () => {
  it("masks every legacy raw credential variable and keeps the rest", () => {
    expect(
      withoutRawMcpCredentials({
        PATH: "/usr/bin",
        T3_ACP_MCP_AUTHORIZATION: "Bearer dummy-mcp-credential",
        T3_MCP_BEARER_TOKEN: "dummy-mcp-credential",
        T3_CODE_MCP_AUTHORIZATION: "Bearer dummy-mcp-credential",
        T3_ACP_MCP_AUTHORIZATION_FILE: "t3-mcp-fixture/credential",
      }),
    ).toStrictEqual({
      PATH: "/usr/bin",
      T3_ACP_MCP_AUTHORIZATION: undefined,
      T3_MCP_BEARER_TOKEN: undefined,
      T3_CODE_MCP_AUTHORIZATION: undefined,
      T3_ACP_MCP_AUTHORIZATION_FILE: "t3-mcp-fixture/credential",
    });
  });

  it("starts from the inherited environment when none is set", () => {
    expect(withoutRawMcpCredentials(undefined).PATH).toBe(process.env.PATH);
  });
});

describe("makeMcpCredentialFiles", () => {
  const expectOwnerOnly = Effect.fnUntraced(function* (path: string) {
    if ((yield* HostProcess.Platform) === "win32") return;
    expect((yield* (yield* FileSystem.FileSystem).stat(path)).mode & 0o777).toBe(0o600);
  });

  it.effect("rewrites a key's file in place and skips an unchanged header", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* makeMcpCredentialFiles();
      const path = yield* files.write("thread-a", "Bearer dummy-mcp-credential");
      const written = yield* fs.stat(path);
      yield* expectOwnerOnly(path);

      expect(yield* files.write("thread-a", "Bearer dummy-mcp-credential")).toBe(path);
      expect((yield* fs.stat(path)).ino).toEqual(written.ino);

      expect(yield* files.write("thread-a", "Bearer rotated-dummy-mcp-credential")).toBe(path);
      expect(yield* fs.readFileString(path)).toBe("Bearer rotated-dummy-mcp-credential");
      expect((yield* fs.stat(path)).ino).not.toEqual(written.ino);
      yield* expectOwnerOnly(path);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("puts a removed file back at the same path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* makeMcpCredentialFiles();
      const path = yield* files.write("thread-a", "Bearer dummy-mcp-credential");
      yield* files.remove("thread-a");
      expect(yield* fs.exists(path)).toBe(false);

      expect(yield* files.write("thread-a", "Bearer dummy-mcp-credential")).toBe(path);
      expect(yield* fs.readFileString(path)).toBe("Bearer dummy-mcp-credential");
      yield* expectOwnerOnly(path);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves no temporary file behind when a write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const created: Array<string> = [];
      let failRename = true;
      const files = yield* makeMcpCredentialFiles().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempFileScoped: (options) =>
            fs
              .makeTempFileScoped(options)
              .pipe(Effect.tap((path) => Effect.sync(() => created.push(path)))),
          rename: (oldPath, newPath) =>
            failRename
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                  }),
                )
              : fs.rename(oldPath, newPath),
        }),
      );

      // A first write that fails records no header, and remove still clears its file.
      yield* Effect.flip(files.write("thread-a", "Bearer dummy-mcp-credential"));
      const path = created[0]!;
      expect(yield* fs.exists(`${path}.tmp`)).toBe(false);
      yield* files.remove("thread-a");
      expect(yield* fs.exists(path)).toBe(false);

      failRename = false;
      expect(yield* files.write("thread-a", "Bearer dummy-mcp-credential")).toBe(path);
      failRename = true;
      yield* Effect.flip(files.write("thread-a", "Bearer rotated-dummy-mcp-credential"));
      expect(yield* fs.exists(`${path}.tmp`)).toBe(false);
      expect(yield* fs.readFileString(path)).toBe("Bearer dummy-mcp-credential");
      expect(created).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes every key's directory when the scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const written = yield* Effect.scoped(
        Effect.gen(function* () {
          const files = yield* makeMcpCredentialFiles();
          return [
            yield* files.write("thread-a", "Bearer dummy-mcp-credential"),
            yield* files.write("thread-b", "Bearer other-dummy-mcp-credential"),
          ];
        }),
      );
      expect(path.dirname(written[0]!)).not.toBe(path.dirname(written[1]!));
      for (const file of written) {
        expect(yield* fs.exists(path.dirname(file))).toBe(false);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
