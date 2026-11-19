// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Exercises checkpoint files on a temporary folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createCheckpoint, diffCheckpoint, listCheckpoints, restoreCheckpoint } from "./gameCheckpoints.ts";

async function unityProject() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-checkpoint-"));
  await NodeFSP.mkdir(NodePath.join(root, "Assets", "Scenes"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "Library"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "ProjectSettings"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "Assets", "Scenes", "Main.unity"), "%YAML 1.1\nGameObject: Player\n");
  await NodeFSP.writeFile(NodePath.join(root, "Assets", "Player.cs"), "class Player {}\n");
  await NodeFSP.writeFile(NodePath.join(root, "Assets", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  await NodeFSP.writeFile(NodePath.join(root, "Library", "cache.bin"), "regenerated");
  await NodeFSP.writeFile(NodePath.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.29f1\n");
  return root;
}

describe("game project checkpoints", () => {
  it("copies covered files, diffs later edits, and restores them", async () => {
    const root = await unityProject();
    const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-base-"));
    const checkpoint = await createCheckpoint({ baseDir, projectRoot: root, engine: "unity", label: "Before inventory", paths: undefined, createdBy: "agent", robloxSnapshot: null, now: new Date("2026-11-19T12:00:00Z") });
    expect(checkpoint).toMatchObject({ fileCount: 4, label: "Before inventory", covers: ["Assets", "ProjectSettings", "Packages/manifest.json"] });

    await NodeFSP.writeFile(NodePath.join(root, "Assets", "Player.cs"), "class Player { int coins; }\n");
    await NodeFSP.rm(NodePath.join(root, "Assets", "icon.png"));
    await NodeFSP.writeFile(NodePath.join(root, "Assets", "Inventory.cs"), "class Inventory {}\n");
    await NodeFSP.writeFile(NodePath.join(root, "Library", "cache.bin"), "changed but excluded");

    const diff = await diffCheckpoint(baseDir, root, checkpoint.checkpointId);
    expect(diff.changes.map((change) => [change.path, change.change])).toEqual([
      ["Assets/icon.png", "deleted"],
      ["Assets/Inventory.cs", "added"],
      ["Assets/Player.cs", "modified"],
    ]);
    expect(diff.changes.find((change) => change.path === "Assets/Player.cs")?.diff).toContain("+class Player { int coins; }");

    await restoreCheckpoint(baseDir, root, checkpoint.checkpointId);
    expect(await NodeFSP.readFile(NodePath.join(root, "Assets", "Player.cs"), "utf8")).toBe("class Player {}\n");
    expect((await NodeFSP.readFile(NodePath.join(root, "Assets", "icon.png"))).length).toBe(7);
    await expect(NodeFSP.access(NodePath.join(root, "Assets", "Inventory.cs"))).rejects.toThrow();
    expect((await diffCheckpoint(baseDir, root, checkpoint.checkpointId)).changes).toEqual([]);
    expect(await listCheckpoints(baseDir, root)).toHaveLength(1);
  });

  it("refuses ids that are not checkpoints", async () => {
    const root = await unityProject();
    const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-base-"));
    await expect(diffCheckpoint(baseDir, root, "../../etc")).rejects.toThrow("Unknown checkpoint.");
  });
});
