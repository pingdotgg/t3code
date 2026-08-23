// @effect-diagnostics nodeBuiltinImport:off - model downloader tests use local Node fixtures.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { downloadVerifiedModel } from "./speechModel.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

describe("downloadVerifiedModel", () => {
  it("publishes bytes only after size and sha256 verification", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-speech-model-"));
    directories.push(directory);
    const bytes = Buffer.from("verified model bytes");
    const server = NodeHttp.createServer((_request, response) => response.end(bytes));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    try {
      const path = await downloadVerifiedModel({
        directory,
        filename: "model.gguf",
        url: `http://127.0.0.1:${address.port}/model.gguf`,
        size: bytes.length,
        sha256: "03cfa25d83f5eaa1faac98ed6ceaaf0e7afe3c273a1e1502c2714ebe10b8263e",
      });

      expect(await NodeFSP.readFile(path)).toEqual(bytes);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("removes partial bytes when verification fails", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-speech-model-"));
    directories.push(directory);
    const server = NodeHttp.createServer((_request, response) => response.end("corrupt"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    try {
      await expect(
        downloadVerifiedModel({
          directory,
          filename: "model.gguf",
          url: `http://127.0.0.1:${address.port}/model.gguf`,
          size: 7,
          sha256: "0".repeat(64),
        }),
      ).rejects.toThrow("verification failed");
      await expect(NodeFSP.stat(NodePath.join(directory, "model.gguf"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
