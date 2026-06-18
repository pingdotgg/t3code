// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  cleanupHostMcpAdvertisements,
  createHostMcpAdvertisement,
  mergeHostMcpServers,
  readHostMcpAdvertisements,
  resolveHostMcpAdvertisementDir,
  writeHostMcpAdvertisement,
} from "./hostMcp.ts";

const nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);

const workspace = {
  key: "file::/repo",
  name: "repo",
  cwd: "/repo",
  uriScheme: "file",
  uriAuthority: "",
};

const server = {
  name: "t3code-vscode-a",
  socketPath: "/tmp/t3code-vscode-mcp-a/mcp.sock",
  toolTimeoutSec: 120,
};

describe("host MCP advertisements", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function makeT3Home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-host-mcp-"));
    tempDirs.push(dir);
    return dir;
  }

  it("writes one independent advertisement file per host", () => {
    const t3Home = makeT3Home();

    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "host-a",
        nowMs,
        mcpServer: server,
        workspaceFolders: [workspace],
        activeWorkspaceFolderKey: workspace.key,
      }),
    });
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "host-b",
        nowMs,
        mcpServer: { ...server, name: "t3code-vscode-b" },
        workspaceFolders: [{ ...workspace, cwd: "/repo-b" }],
      }),
    });

    expect(fs.readdirSync(resolveHostMcpAdvertisementDir(t3Home)).toSorted()).toEqual([
      "host-a.json",
      "host-b.json",
    ]);
    expect(readHostMcpAdvertisements({ t3Home, nowMs }).advertisements).toHaveLength(2);
  });

  it("filters expired, malformed, and non-matching advertisements", () => {
    const t3Home = makeT3Home();
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "live",
        nowMs,
        mcpServer: server,
        workspaceFolders: [workspace],
      }),
    });
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "expired",
        nowMs: nowMs - 60_000,
        ttlMs: 1,
        mcpServer: { ...server, name: "expired" },
        workspaceFolders: [workspace],
      }),
    });
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "other",
        nowMs,
        mcpServer: { ...server, name: "other" },
        workspaceFolders: [{ ...workspace, cwd: "/other" }],
      }),
    });
    fs.writeFileSync(path.join(resolveHostMcpAdvertisementDir(t3Home), "bad.json"), "{", "utf8");

    const result = readHostMcpAdvertisements({
      t3Home,
      nowMs,
      workspaceRoot: "/repo",
    });

    expect(result.malformed).toBe(1);
    expect(result.advertisements.map((entry) => entry.hostId)).toEqual(["live"]);
  });

  it("cleans expired files only after the grace period", () => {
    const t3Home = makeT3Home();
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "expired",
        nowMs,
        ttlMs: 1,
        mcpServer: server,
        workspaceFolders: [workspace],
      }),
    });
    writeHostMcpAdvertisement({
      t3Home,
      advertisement: createHostMcpAdvertisement({
        hostId: "live",
        nowMs,
        mcpServer: { ...server, name: "live" },
        workspaceFolders: [workspace],
      }),
    });

    expect(
      cleanupHostMcpAdvertisements({ t3Home, nowMs: nowMs + 10_000, graceMs: 60_000 }),
    ).toEqual({ deleted: 0, errors: 0 });
    expect(
      cleanupHostMcpAdvertisements({ t3Home, nowMs: nowMs + 70_000, graceMs: 60_000 }),
    ).toEqual({ deleted: 1, errors: 0 });
    expect(fs.readdirSync(resolveHostMcpAdvertisementDir(t3Home)).toSorted()).toEqual([
      "live.json",
    ]);
  });

  it("merges discovered servers without duplicating bootstrap names", () => {
    expect(
      mergeHostMcpServers(
        [server],
        [server, { ...server, name: "t3code-vscode-b", socketPath: "/tmp/b.sock" }],
      ),
    ).toEqual([server, { ...server, name: "t3code-vscode-b", socketPath: "/tmp/b.sock" }]);
  });
});
