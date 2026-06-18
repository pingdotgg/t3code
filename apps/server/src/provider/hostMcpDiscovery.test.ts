// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { createHostMcpAdvertisement, writeHostMcpAdvertisement } from "@t3tools/shared/hostMcp";

import {
  resolveHostMcpServersForProviderStart,
  resolveHostMcpServersForWorkspace,
} from "./hostMcpDiscovery.ts";

describe("host MCP discovery", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
    vi.restoreAllMocks();
  });

  function makeT3Home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-host-mcp-discovery-"));
    tempDirs.push(dir);
    return dir;
  }

  it("adds the first live matching advertisement to bootstrap servers", async () => {
    const t3Home = makeT3Home();
    const nowMs = Date.now();
    const bootstrapServer = {
      name: "bootstrap",
      socketPath: "/tmp/bootstrap.sock",
    };
    const discoveredServer = {
      name: "t3code-vscode-discovered",
      socketPath: "/tmp/discovered.sock",
      toolTimeoutSec: 120,
    };
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "host-b",
        nowMs,
        mcpServer: { ...discoveredServer, name: "not-matching" },
        workspaceFolders: [
          {
            key: "file::/other",
            name: "other",
            cwd: "/other",
            uriScheme: "file",
            uriAuthority: "",
          },
        ],
      }),
    });
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "host-a",
        nowMs,
        mcpServer: discoveredServer,
        workspaceFolders: [
          {
            key: "file::/repo",
            name: "repo",
            cwd: "/repo",
            uriScheme: "file",
            uriAuthority: "",
          },
        ],
      }),
    });

    await expect(
      resolveHostMcpServersForWorkspace({
        t3Home,
        workspaceRoot: "/repo",
        bootstrapServers: [bootstrapServer],
        socketPathExists: () => true,
        probe: async () => true,
      }),
    ).resolves.toEqual([bootstrapServer, discoveredServer]);
  });

  it("ignores duplicate names, missing sockets, and failed probes", async () => {
    const t3Home = makeT3Home();
    const nowMs = Date.now();
    const bootstrapServer = {
      name: "t3code-vscode-bootstrap",
      socketPath: "/tmp/bootstrap.sock",
    };
    for (const [hostId, server] of [
      ["duplicate", bootstrapServer],
      ["missing", { name: "missing", socketPath: "/tmp/missing.sock" }],
      ["failed", { name: "failed", socketPath: "/tmp/failed.sock" }],
    ] as const) {
      writeHostMcpAdvertisement({
        t3Home,
        advertisement: createHostMcpAdvertisement({
          hostId,
          nowMs,
          mcpServer: server,
          workspaceFolders: [
            {
              key: "file::/repo",
              name: "repo",
              cwd: "/repo",
              uriScheme: "file",
              uriAuthority: "",
            },
          ],
        }),
      });
    }

    await expect(
      resolveHostMcpServersForWorkspace({
        t3Home,
        workspaceRoot: "/repo",
        bootstrapServers: [bootstrapServer],
        socketPathExists: (socketPath) => socketPath !== "/tmp/missing.sock",
        probe: async (socketPath) => socketPath !== "/tmp/failed.sock",
      }),
    ).resolves.toEqual([bootstrapServer]);
  });

  it("falls back to bootstrap servers when provider-start discovery fails", async () => {
    const t3Home = path.join(makeT3Home(), "not-a-directory");
    fs.writeFileSync(t3Home, "");
    const bootstrapServer = {
      name: "bootstrap",
      socketPath: "/tmp/bootstrap.sock",
    };

    await expect(
      resolveHostMcpServersForProviderStart({
        serverConfig: {
          baseDir: t3Home,
          hostMcpServers: [bootstrapServer],
        },
        sessionInput: {
          cwd: "/repo",
        },
      }),
    ).resolves.toEqual([bootstrapServer]);
  });

  it("falls back to bootstrap servers when direct workspace discovery fails", async () => {
    const t3Home = path.join(makeT3Home(), "not-a-directory");
    fs.writeFileSync(t3Home, "");
    const bootstrapServer = {
      name: "bootstrap",
      socketPath: "/tmp/bootstrap.sock",
    };

    await expect(
      resolveHostMcpServersForWorkspace({
        t3Home,
        workspaceRoot: "/repo",
        bootstrapServers: [bootstrapServer],
      }),
    ).resolves.toEqual([bootstrapServer]);
  });
});
