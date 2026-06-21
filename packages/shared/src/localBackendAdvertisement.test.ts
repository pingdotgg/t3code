// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  cleanupLocalBackendAdvertisements,
  createLocalBackendAdvertisement,
  readLocalBackendAdvertisements,
  resolveLocalBackendAdvertisementDir,
  writeLocalBackendAdvertisement,
} from "./localBackendAdvertisement.ts";

const nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);

const workspace = {
  key: "file::/repo",
  name: "repo",
  cwd: "/repo",
  uriScheme: "file",
  uriAuthority: "",
};

describe("local backend advertisements", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function makeT3Home(): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-backend-"));
    tempDirs.push(dir);
    return dir;
  }

  it("writes one independent advertisement file per backend", () => {
    const t3Home = makeT3Home();

    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "backend-a",
        nowMs,
        httpBaseUrl: "http://127.0.0.1:49111",
        bearerToken: "token-a",
        workspaceFolders: [workspace],
        activeWorkspaceFolderKey: workspace.key,
      }),
    });
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "backend-b",
        nowMs,
        httpBaseUrl: "http://127.0.0.1:49112",
        bearerToken: "token-b",
        workspaceFolders: [{ ...workspace, cwd: "/repo-b" }],
      }),
    });

    expect(NodeFS.readdirSync(resolveLocalBackendAdvertisementDir(t3Home)).toSorted()).toEqual([
      "backend-a.json",
      "backend-b.json",
    ]);
    expect(readLocalBackendAdvertisements({ t3Home, nowMs }).advertisements).toHaveLength(2);
  });

  it("filters expired, malformed, and non-matching advertisements", () => {
    const t3Home = makeT3Home();
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "live",
        nowMs,
        httpBaseUrl: "http://127.0.0.1:49111",
        bearerToken: "token",
        workspaceFolders: [workspace],
      }),
    });
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "expired",
        nowMs: nowMs - 60_000,
        ttlMs: 1,
        httpBaseUrl: "http://127.0.0.1:49112",
        bearerToken: "expired",
        workspaceFolders: [workspace],
      }),
    });
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "other",
        nowMs,
        httpBaseUrl: "http://127.0.0.1:49113",
        bearerToken: "other",
        workspaceFolders: [{ ...workspace, cwd: "/other" }],
      }),
    });
    NodeFS.writeFileSync(
      NodePath.join(resolveLocalBackendAdvertisementDir(t3Home), "bad.json"),
      "{",
      "utf8",
    );

    const result = readLocalBackendAdvertisements({
      t3Home,
      nowMs,
      workspaceRoot: "/repo",
    });

    expect(result.malformed).toBe(1);
    expect(result.advertisements.map((entry) => entry.backendId)).toEqual(["live"]);
  });

  it("orders active workspace backends before inactive backends", () => {
    const t3Home = makeT3Home();
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "backend-a",
        nowMs,
        httpBaseUrl: "http://127.0.0.1:49111",
        bearerToken: "token-a",
        workspaceFolders: [workspace],
      }),
    });
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "backend-b",
        nowMs,
        httpBaseUrl: "http://127.0.0.1:49112",
        bearerToken: "token-b",
        workspaceFolders: [workspace],
        activeWorkspaceFolderKey: workspace.key,
      }),
    });

    expect(
      readLocalBackendAdvertisements({ t3Home, nowMs }).advertisements.map(
        (entry) => entry.backendId,
      ),
    ).toEqual(["backend-b", "backend-a"]);
  });

  it("cleans expired files only after the grace period", () => {
    const t3Home = makeT3Home();
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "expired",
        nowMs,
        ttlMs: 1,
        httpBaseUrl: "http://127.0.0.1:49111",
        bearerToken: "expired",
        workspaceFolders: [workspace],
      }),
    });
    writeLocalBackendAdvertisement({
      t3Home,
      advertisement: createLocalBackendAdvertisement({
        backendId: "live",
        nowMs,
        httpBaseUrl: "http://127.0.0.1:49112",
        bearerToken: "live",
        workspaceFolders: [workspace],
      }),
    });

    expect(
      cleanupLocalBackendAdvertisements({ t3Home, nowMs: nowMs + 10_000, graceMs: 60_000 }),
    ).toEqual({ deleted: 0, errors: 0 });
    expect(
      cleanupLocalBackendAdvertisements({ t3Home, nowMs: nowMs + 70_000, graceMs: 60_000 }),
    ).toEqual({ deleted: 1, errors: 0 });
    expect(NodeFS.readdirSync(resolveLocalBackendAdvertisementDir(t3Home)).toSorted()).toEqual([
      "live.json",
    ]);
  });
});
