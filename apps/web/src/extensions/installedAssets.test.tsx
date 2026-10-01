import * as React from "react";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionInstallation } from "@t3tools/contracts";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import { createInstalledExtensionController, type InstalledSnapshot } from "./installedController";

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const manifest = { id: "example.asset", version: "1.0.0", apiVersion: 1, surfaces: [] };
const installation: ExtensionInstallation = {
  id: manifest.id,
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities: [], projectIds: [] },
  package: {
    format: 4,
    manifest,
    clientEntry: "client.mjs",
    tools: [],
    dependencies: [],
    provides: [],
    requires: [],
    assets: [
      {
        path: "assets/core.wasm",
        byteLength: bytes.length,
        sha256: digest,
        mediaType: "application/wasm",
      },
    ],
  },
};
function fixture(formats = [1, 2, 3, 4]) {
  let catalogue: readonly ExtensionInstallation[] = [installation];
  let host: ClientHost | undefined;
  const snapshots: InstalledSnapshot[] = [];
  const readAsset = vi.fn(async (_id: string, _hash: string, _path: string, _signal: AbortSignal) =>
    bytes.slice(),
  );
  const unregister = vi.fn();
  const controller = createInstalledExtensionController({
    environmentId: "asset-env",
    React,
    list: async () => ({
      installations: catalogue,
      supportedPackageFormats: formats,
      supportsApiStreams: true,
    }),
    client: async (_id, contentHash) => ({ code: "independent asset fixture", contentHash }),
    readAsset,
    invoke: async () => null,
    load: async () => (bindings: ClientHost) => {
      host = bindings;
      return { manifest, surfaces: [] };
    },
    register: () => unregister,
    changed: (snapshot) => snapshots.push(snapshot),
  });
  return {
    controller,
    readAsset,
    snapshots,
    unregister,
    host: () => {
      if (!host) throw new Error("factory not loaded");
      return host;
    },
    setCatalogue: (next: readonly ExtensionInstallation[]) => {
      catalogue = next;
    },
  };
}
describe("installed package assets", () => {
  it("negotiates format4 before loading code", async () => {
    const f = fixture([1, 2, 3]);
    await f.controller.refresh();
    expect(f.snapshots.at(-1)?.error).toContain("does not support package format 4");
    expect(() => f.host()).toThrow("not loaded");
    expect(f.readAsset).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("binds exact package/hash/path and delivers independently hashed valid WASM bytes", async () => {
    const f = fixture();
    await f.controller.refresh();
    const result = await f.host().readAsset!("assets/core.wasm", new AbortController().signal);
    expect(f.readAsset).toHaveBeenCalledWith(
      installation.id,
      installation.contentHash,
      "assets/core.wasm",
      expect.any(AbortSignal),
    );
    expect(result).toEqual({ bytes, sha256: digest, mediaType: "application/wasm" });
    expect(WebAssembly.validate(result.bytes.slice())).toBe(true);
    f.controller.dispose();
  });
  it("refuses undeclared paths and legacy packages before transport", async () => {
    const f = fixture();
    await f.controller.refresh();
    for (const path of ["../core.wasm", "/assets/core.wasm", "assets/other.wasm"])
      await expect(f.host().readAsset!(path, new AbortController().signal)).rejects.toThrow(
        "not declared",
      );
    expect(f.readAsset).not.toHaveBeenCalled();
    f.setCatalogue([
      {
        ...installation,
        contentHash: "b".repeat(64),
        package: { format: 1, manifest, clientEntry: "client.mjs", tools: [] },
      },
    ]);
    await f.controller.refresh();
    await expect(
      f.host().readAsset!("assets/core.wasm", new AbortController().signal),
    ).rejects.toThrow("not declared");
    f.controller.dispose();
  });
  it("rejects wrong length and same-length corrupt bytes", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.readAsset.mockResolvedValueOnce(bytes.slice(1));
    await expect(
      f.host().readAsset!("assets/core.wasm", new AbortController().signal),
    ).rejects.toThrow("length mismatch");
    const corrupt = bytes.slice();
    corrupt[0] = 42;
    f.readAsset.mockResolvedValueOnce(corrupt);
    await expect(
      f.host().readAsset!("assets/core.wasm", new AbortController().signal),
    ).rejects.toThrow("digest mismatch");
    f.controller.dispose();
  });
  for (const action of ["disable", "remove", "update", "dispose", "cancel"] as const) {
    it("rejects a late response after " + action, async () => {
      const f = fixture();
      await f.controller.refresh();
      let deliver!: (value: typeof bytes) => void;
      let requestSignal!: AbortSignal;
      f.readAsset.mockImplementation((_id, _hash, _path, signal) => {
        requestSignal = signal;
        return new Promise((resolve) => {
          deliver = resolve;
        });
      });
      const caller = new AbortController();
      const old = f.host();
      const pending = old.readAsset!("assets/core.wasm", caller.signal);
      if (action === "cancel") caller.abort();
      else if (action === "dispose") f.controller.dispose();
      else {
        f.setCatalogue(
          action === "remove"
            ? []
            : [
                {
                  ...installation,
                  ...(action === "disable" ? { enabled: false } : { contentHash: "b".repeat(64) }),
                },
              ],
        );
        await f.controller.refresh();
      }
      expect(requestSignal.aborted).toBe(true);
      deliver(bytes.slice());
      await expect(pending).rejects.toThrow("expired");
      f.controller.dispose();
    });
  }
});
