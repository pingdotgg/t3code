import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  agentcastCodexApprovals,
  agentcastStdioServer,
  resolveAgentcastLauncher,
} from "./agentcastMcp.ts";

describe("resolveAgentcastLauncher", () => {
  effectIt.effect("is off unless T3CODE_AGENTCAST_MAIN is set", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* resolveAgentcastLauncher({}));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("runs agentcast with the server's own runtime when it is Node", () =>
    Effect.gen(function* () {
      const launcher = yield* resolveAgentcastLauncher({
        T3CODE_AGENTCAST_MAIN: "/opt/agentcast/dist/agentcast.mjs",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      }).pipe(
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
      );
      assert.deepStrictEqual(launcher, {
        node: "/usr/bin/node",
        main: "/opt/agentcast/dist/agentcast.mjs",
        env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("is off in a packaged binary with no Node.js on PATH", () =>
    Effect.gen(function* () {
      const launcher = yield* resolveAgentcastLauncher({
        T3CODE_AGENTCAST_MAIN: "/opt/agentcast/dist/agentcast.mjs",
        PATH: "/nonexistent",
      }).pipe(
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.ExecutablePath, "/opt/t3/t3"),
      );
      assert.isUndefined(launcher);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("agentcastStdioServer", () => {
  it("runs agentcast mcp with the thread as its client name", () => {
    const server = agentcastStdioServer("thread-1", {
      node: "/usr/bin/node",
      main: "/opt/agentcast/dist/agentcast.mjs",
      env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
    });
    expect(server?.command).toBe("/usr/bin/node");
    expect(server?.args).toEqual(["/opt/agentcast/dist/agentcast.mjs", "mcp"]);
    expect(server?.env).toMatchObject({
      AGENTCAST_CLIENT: "t3:thread-1",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
  });

  it("is off without a launcher", () => {
    expect(agentcastStdioServer("thread-1", undefined)).toBeUndefined();
  });
});

describe("agentcastCodexApprovals", () => {
  it("approves everything only in full-access with a sandbox that can write", () => {
    expect(agentcastCodexApprovals({ runtimeMode: "full-access" })).toEqual({
      default_tools_approval_mode: "approve",
    });
  });

  it("asks before write tools in other modes", () => {
    expect(agentcastCodexApprovals({ runtimeMode: "auto" })).toMatchObject({
      default_tools_approval_mode: "prompt",
    });
  });

  it("offers only the read-only tools in a read-only sandbox, in any mode", () => {
    for (const runtimeMode of ["full-access", "auto"]) {
      const config = agentcastCodexApprovals({ runtimeMode, sandboxPolicy: { type: "readOnly" } });
      expect(config.enabled_tools).toContain("read");
      expect(config.enabled_tools).not.toContain("act");
      expect(config.enabled_tools).not.toContain("exec");
    }
  });
});
