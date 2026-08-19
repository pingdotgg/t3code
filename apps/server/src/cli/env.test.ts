// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem round-trips like pair.test.ts does.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readCatalog, upsertEnvironmentRecord, writeCatalog } from "./env.ts";

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
    expect(result[0]?.label).toBe("sandbox-new");
  });

  it("leaves unrelated environments untouched", () => {
    const other = makeRecord({
      environmentId: "env_other" as PersistedSavedEnvironmentRecord["environmentId"],
      label: "other",
    });
    const result = upsertEnvironmentRecord([other], makeRecord());
    expect(result).toHaveLength(2);
    expect(result.some((record) => record.environmentId === "env_other")).toBe(true);
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
        }).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<
          { readonly version: number; readonly records: readonly PersistedSavedEnvironmentRecord[] },
          never
        >,
      );
      expect(document.records).toEqual([]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a record through writeCatalog and readCatalog", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-env-test-"));
    try {
      const catalogPath = NodePath.join(dir, "saved-environments.json");
      const record = makeRecord();
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
