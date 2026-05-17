// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type { AcpRegistryEntry } from "@t3tools/contracts";

import {
  availableChannels,
  installAgent,
  resolveSpawnTarget,
  uninstallAgent,
} from "./installer.ts";

function rawEntry(sha256: string, cmd = "./bin/test-agent"): AcpRegistryEntry {
  return {
    id: "test-agent",
    name: "Test Agent",
    version: "1.0.0",
    description: "Test ACP agent",
    distribution: {
      binary: {
        "linux-x86_64": {
          archive: "https://example.test/agent",
          sha256,
          cmd,
        },
      },
    },
  };
}

function fetchBytes(bytes: Uint8Array): typeof fetch {
  return ((_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
    Promise.resolve(
      new Response(bytes, {
        status: 200,
      }),
    )) as unknown as typeof fetch;
}

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

describe("ACP registry installer", () => {
  it("downloads raw binaries into path-joined cache locations and verifies sha256", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-acp-install-"));
    const bytes = new TextEncoder().encode("#!/bin/sh\necho ok\n");
    const entry = rawEntry(sha256(bytes));

    const result = await installAgent(entry, {
      cacheRoot,
      platform: "linux-x86_64",
      fetchImpl: fetchBytes(bytes),
    });

    const binaryPath = NodePath.join(cacheRoot, entry.id, entry.version, "bin", "test-agent");
    expect(result.state.binaryPath).toBe(binaryPath);
    await expect(NodeFSP.readFile(binaryPath, "utf8")).resolves.toBe("#!/bin/sh\necho ok\n");
    expect(resolveSpawnTarget(entry, result.state, { platform: "linux-x86_64" })?.command).toBe(
      binaryPath,
    );

    await uninstallAgent(entry, cacheRoot);
    await expect(NodeFSP.stat(NodePath.join(cacheRoot, entry.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects downloaded binaries when the manifest sha256 does not match", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-acp-install-"));
    const bytes = new TextEncoder().encode("not what the manifest promised");
    const entry = rawEntry("0".repeat(64));

    await expect(
      installAgent(entry, {
        cacheRoot,
        platform: "linux-x86_64",
        fetchImpl: fetchBytes(bytes),
      }),
    ).rejects.toMatchObject({
      operation: "verify-download",
      agentId: entry.id,
      expectedChecksum: "0".repeat(64),
      actualChecksum: sha256(bytes),
    });
  });

  it("keeps raw downloads when cmd resolves to the temporary archive path", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-acp-install-"));
    const bytes = new TextEncoder().encode("raw executable");
    const entry = rawEntry(sha256(bytes), "./agent.bin");

    const result = await installAgent(entry, {
      cacheRoot,
      platform: "linux-x86_64",
      fetchImpl: fetchBytes(bytes),
    });

    const binaryPath = NodePath.join(cacheRoot, entry.id, entry.version, "agent.bin");
    expect(result.state.binaryPath).toBe(binaryPath);
    await expect(NodeFSP.readFile(binaryPath, "utf8")).resolves.toBe("raw executable");
  });

  it("rejects binary command paths outside the install root", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-acp-install-"));
    const bytes = new TextEncoder().encode("raw executable");

    await expect(
      installAgent(rawEntry(sha256(bytes), "../agent"), {
        cacheRoot,
        platform: "linux-x86_64",
        fetchImpl: fetchBytes(bytes),
      }),
    ).rejects.toThrow("escapes the install root");

    await expect(
      installAgent(rawEntry(sha256(bytes), NodePath.join(cacheRoot, "agent")), {
        cacheRoot,
        platform: "linux-x86_64",
        fetchImpl: fetchBytes(bytes),
      }),
    ).rejects.toThrow("must be relative");
  });

  it("advertises binary installs even without manifest checksums (Zed parity)", () => {
    const entry = rawEntry("");
    const target = entry.distribution.binary?.["linux-x86_64"];
    if (target) {
      delete (target as { sha256?: string }).sha256;
    }

    expect(availableChannels(entry, "linux-x86_64")).toEqual(["binary"]);
  });

  it("installs unchecked binaries without sha256 verification", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const entry = rawEntry("");
    const target = entry.distribution.binary?.["linux-x86_64"];
    if (target) {
      delete (target as { sha256?: string }).sha256;
    }
    const cacheRoot = NodePath.join(NodeOS.tmpdir(), `acp-installer-test-${Date.now()}`);

    const result = await installAgent(entry, {
      cacheRoot,
      platform: "linux-x86_64",
      fetchImpl: fetchBytes(bytes),
    });

    expect(result.state.distribution).toBe("binary");
    expect(result.state.binaryPath).toBeDefined();

    await NodeFSP.rm(cacheRoot, { recursive: true, force: true });
  });
});
