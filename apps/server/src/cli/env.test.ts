// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem round-trips like pair.test.ts does.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  assertLegacyCatalogIsSafeToWrite,
  readCatalog,
  upsertEnvironmentRecord,
  writeCatalog,
} from "./env.ts";

const makeRecord = (
  overrides: Partial<PersistedSavedEnvironmentRecord> = {},
): PersistedSavedEnvironmentRecord => ({
  environmentId: "env_abc" as PersistedSavedEnvironmentRecord["environmentId"],
  label: "sandbox",
  httpBaseUrl: "http://100.64.0.7:3773",
  wsBaseUrl: "ws://100.64.0.7:3773",
  createdAt: "2026-08-19T00:00:00.000Z",
  lastConnectedAt: null,
  ...overrides,
});

describe("upsertEnvironmentRecord", () => {
  it("appends a record for a new environment", () => {
    const result = upsertEnvironmentRecord([], makeRecord());
    expect(result).toHaveLength(1);
  });

  it("replaces rather than duplicates a record for the same environment id", () => {
    const first = makeRecord({ label: "sandbox-old" });
    const second = makeRecord({ label: "sandbox-new" });
    const result = upsertEnvironmentRecord([first], second);
    expect(result).toHaveLength(1);
    expect(result[0]?.["label"]).toBe("sandbox-new");
  });

  it("leaves unrelated environments untouched, including fields this command does not know about", () => {
    // The bug reported in review: decoding existing records through
    // PersistedSavedEnvironmentRecordSchema silently dropped fields like
    // encryptedBearerToken that schema has no key for. This asserts an
    // opaque field survives a merge untouched, byte for byte.
    const other = {
      environmentId: "env_other",
      label: "other",
      httpBaseUrl: "http://100.64.0.8:3773",
      wsBaseUrl: "ws://100.64.0.8:3773",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastConnectedAt: null,
      encryptedBearerToken: "some-opaque-base64-blob-unrelated-to-this-command",
    };
    const result = upsertEnvironmentRecord([other], makeRecord());
    expect(result).toHaveLength(2);
    const preserved = result.find((record) => record["environmentId"] === "env_other");
    expect(preserved?.["encryptedBearerToken"]).toBe(
      "some-opaque-base64-blob-unrelated-to-this-command",
    );
  });
});

describe("env catalog read/write", () => {
  it("reads an empty document when the catalog file does not exist yet", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-env-test-"));
    try {
      const catalogPath = NodePath.join(dir, "nested", "saved-environments.json");
      const document = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return yield* readCatalog(fileSystem, catalogPath);
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(document.records).toEqual([]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a record through writeCatalog and readCatalog, preserving unknown fields", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-env-test-"));
    try {
      const catalogPath = NodePath.join(dir, "saved-environments.json");
      const record = { ...makeRecord(), encryptedBearerToken: "opaque-blob" };
      await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeCatalog(fileSystem, path, catalogPath, {
            version: 1,
            records: [record],
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      );

      const document = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return yield* readCatalog(fileSystem, catalogPath);
        }).pipe(Effect.provide(NodeServices.layer)),
      );

      expect(document.records).toEqual([record]);
      expect(document.records[0]?.["encryptedBearerToken"]).toBe("opaque-blob");
      // Atomic-write means no stray temp file survives a clean run.
      assert(
        NodeFS.readdirSync(dir).every((name) => !name.includes(".tmp")),
        "no leftover temp file after a successful write",
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertLegacyCatalogIsSafeToWrite", () => {
  it("passes when no sibling encrypted catalog exists", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-env-test-"));
    try {
      const catalogPath = NodePath.join(dir, "saved-environments.json");
      await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* assertLegacyCatalogIsSafeToWrite(fileSystem, path, catalogPath);
        }).pipe(Effect.provide(NodeServices.layer)),
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the real encrypted catalog already exists next to the legacy path", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-env-test-"));
    try {
      const catalogPath = NodePath.join(dir, "saved-environments.json");
      NodeFS.writeFileSync(
        NodePath.join(dir, "connection-catalog.json"),
        JSON.stringify({ version: 1, encryptedCatalog: "does-not-matter-for-this-test" }),
      );
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* assertLegacyCatalogIsSafeToWrite(fileSystem, path, catalogPath);
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
