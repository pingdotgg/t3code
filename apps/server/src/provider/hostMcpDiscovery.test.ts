// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { createHostMcpAdvertisement, writeHostMcpAdvertisement } from "@t3tools/shared/hostMcp";

import {
  type HostMcpDiscoveryDiagnostic,
  resolveHostMcpServersForProviderStart,
  resolveHostMcpServersForWorkspace,
} from "./hostMcpDiscovery.ts";

describe("host MCP discovery", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
    vi.restoreAllMocks();
  });

  function makeT3Home(): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-host-mcp-discovery-"));
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
    const diagnostics: HostMcpDiscoveryDiagnostic[] = [];
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
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toEqual([bootstrapServer]);
    expect(diagnostics.map((diagnostic) => diagnostic.reason).toSorted()).toEqual(
      ["duplicate-server-name", "probe-failed", "socket-missing"].toSorted(),
    );
  });

  it("treats injected socket existence failures as unavailable advertisements", async () => {
    const t3Home = makeT3Home();
    const nowMs = Date.now();
    const diagnostics: HostMcpDiscoveryDiagnostic[] = [];
    const bootstrapServer = {
      name: "bootstrap",
      socketPath: "/tmp/bootstrap.sock",
    };
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "host-a",
        nowMs,
        mcpServer: {
          name: "throws",
          socketPath: "/tmp/throws.sock",
        },
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
        socketPathExists: () => {
          throw new Error("socket check failed");
        },
        probe: async () => true,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toEqual([bootstrapServer]);
    expect(diagnostics).toEqual([
      {
        reason: "socket-check-failed",
        serverName: "throws",
        socketPath: "/tmp/throws.sock",
        detail: "socket check failed",
      },
    ]);
  });

  it("treats injected probe rejections as failed probes", async () => {
    const t3Home = makeT3Home();
    const nowMs = Date.now();
    const diagnostics: HostMcpDiscoveryDiagnostic[] = [];
    const bootstrapServer = {
      name: "bootstrap",
      socketPath: "/tmp/bootstrap.sock",
    };
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "host-a",
        nowMs,
        mcpServer: {
          name: "rejects",
          socketPath: "/tmp/rejects.sock",
        },
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
        probe: async () => {
          throw new Error("probe failed");
        },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toEqual([bootstrapServer]);
    expect(diagnostics).toEqual([
      {
        reason: "probe-rejected",
        serverName: "rejects",
        socketPath: "/tmp/rejects.sock",
        detail: "probe failed",
      },
    ]);
  });

  it("uses the advertised socket path without deriving an HTTP MCP endpoint", async () => {
    const t3Home = makeT3Home();
    const nowMs = Date.now();
    const socketPath = "/tmp/t3code-vscode-bound-host-audit/mcp.sock";
    const probedSocketPaths: string[] = [];
    const discoveredServer = {
      name: "t3code-vscode-discovered",
      socketPath,
    };
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
        bootstrapServers: [],
        socketPathExists: (candidateSocketPath) => candidateSocketPath === socketPath,
        probe: async (candidateSocketPath) => {
          probedSocketPaths.push(candidateSocketPath);
          return true;
        },
      }),
    ).resolves.toEqual([discoveredServer]);
    expect(probedSocketPaths).toEqual([socketPath]);
  });

  it("falls back to bootstrap servers when provider-start discovery fails", async () => {
    const t3Home = NodePath.join(makeT3Home(), "not-a-directory");
    NodeFS.writeFileSync(t3Home, "");
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
    const t3Home = NodePath.join(makeT3Home(), "not-a-directory");
    NodeFS.writeFileSync(t3Home, "");
    const diagnostics: HostMcpDiscoveryDiagnostic[] = [];
    const bootstrapServer = {
      name: "bootstrap",
      socketPath: "/tmp/bootstrap.sock",
    };

    await expect(
      resolveHostMcpServersForWorkspace({
        t3Home,
        workspaceRoot: "/repo",
        bootstrapServers: [bootstrapServer],
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toEqual([bootstrapServer]);
    expect(diagnostics).toEqual([
      {
        reason: "advertisements-read-failed",
        detail: expect.any(String),
      },
    ]);
  });
});
