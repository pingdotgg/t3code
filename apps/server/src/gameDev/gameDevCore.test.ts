// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Runs the real Unreal bridge plugin in a Python subprocess against a live core.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { GameDevCore } from "./gameDevCore.ts";

const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const FAKE_UNREAL = NodePath.join(REPO, "integrations/game-bridges/tests/fake_unreal.py");
const hasPython = NodeChildProcess.spawnSync("python3", ["--version"]).status === 0;
const blender = process.env.CONTINUUM_TEST_BLENDER ?? null;

async function startCore() {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-gamedev-"));
  const stateDir = NodePath.join(baseDir, "userdata");
  await NodeFSP.mkdir(stateDir, { recursive: true });
  // Port 0 picks a free loopback port, so tests never collide with a running Continuum.
  await NodeFSP.writeFile(NodePath.join(stateDir, "game-dev.json"), JSON.stringify({ settings: { bridgePort: 0, allowCameraControl: true, allowForgeGuiPublishing: false } }));
  const secrets = new Map<string, string>();
  const env = { ...process.env, PATH: blender ? `${NodePath.dirname(blender)}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "") };
  return GameDevCore.start({
    baseDir,
    stateDir,
    platform: "linux",
    arch: "x64",
    env,
    now: () => new Date(),
    getSecret: async (name) => secrets.get(name) ?? null,
    setSecret: async (name, value) => {
      if (value === null) secrets.delete(name);
      else secrets.set(name, value);
    },
  });
}

function waitFor<T>(core: GameDevCore, probe: () => T | null, ms = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = probe();
      if (value !== null) {
        stop();
        clearTimeout(timer);
        resolve(value);
      }
    };
    const stop = core.registry.onChange(check);
    const timer = setTimeout(() => {
      stop();
      reject(new Error("Timed out waiting for the simulated editor."));
    }, ms);
    check();
  });
}

describe.skipIf(!hasPython)("Game Development core with the Unreal plugin in a simulated editor", () => {
  it("installs the bridge, connects, and runs agent operations with approvals, tests, captures, and checkpoints", async () => {
    const core = await startCore();
    const project = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-shooter-"));
    await NodeFSP.writeFile(NodePath.join(project, "Shooter.uproject"), JSON.stringify({ EngineAssociation: "5.6" }));
    await NodeFSP.mkdir(NodePath.join(project, "Content", "Maps"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(project, "Content", "Maps", "Main.umap"), "level-v1");
    const written = await core.installBridge("unreal", project);
    expect(written).toContain(NodePath.join(project, "Plugins", "ContinuumBridge"));
    const config = JSON.parse(await NodeFSP.readFile(NodePath.join(project, ".continuum", "bridge.json"), "utf8")) as { url: string; token: string };
    expect(config.url).toBe(core.bridgeUrl);
    expect(config.token).toHaveLength(48);
    expect(await NodeFSP.readFile(NodePath.join(project, ".continuum", ".gitignore"), "utf8")).toContain("bridge.json");

    const editor = NodeChildProcess.spawn("python3", [FAKE_UNREAL, project, "60"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    editor.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      const session = await waitFor(core, () => {
        const found = core.registry.sessionForProject(project);
        return found?.state === "connected" ? found : null;
      });
      expect(session).toMatchObject({ engine: "unreal", editorVersion: "5.6.1-0+UE5 (simulated)", projectName: "Shooter" });
      expect(core.operationsFor(session)).toEqual(expect.arrayContaining(["scene.tree", "object.create", "tests.run", "blueprint.set_defaults", "build.compile"]));

      const agent = (operation: string, args: Record<string, unknown> = {}) =>
        core.command({ sessionId: null, projectRoot: project, operation, args, actor: "agent", threadId: "thread-1" });

      const tree = await agent("scene.tree");
      expect(tree).toMatchObject({ ok: true, value: { actorCount: 2 } });
      const created = await agent("object.create", { class: "PointLight", label: "Lamp", location: { x: 10, y: 0, z: 200 } });
      expect(created).toMatchObject({ ok: true, value: { label: "Lamp", class: "PointLight", location: { z: 200 } } });
      expect(await agent("object.update", { label: "Lamp", location: { x: 0, y: 0, z: 300 } })).toMatchObject({ value: { location: { z: 300 } } });

      // Deleting waits for the user; deny it once, then approve.
      const denied = agent("object.delete", { label: "Lamp" });
      const [first] = await waitFor(core, () => (core.registry.approvals(project).length > 0 ? core.registry.approvals(project) : null));
      expect(first).toMatchObject({ operation: "object.delete", threadId: "thread-1" });
      core.resolveApproval(first!.approvalId, false);
      await expect(denied).rejects.toThrow("did not approve");
      const approved = agent("object.delete", { label: "Lamp" });
      const [second] = await waitFor(core, () => (core.registry.approvals(project).length > 0 ? core.registry.approvals(project) : null));
      core.resolveApproval(second!.approvalId, true);
      await expect(approved).resolves.toMatchObject({ ok: true, value: { deleted: "Lamp" } });

      await expect(agent("blueprint.set_defaults", { path: "/Game/BP_Player", properties: { MaxWalkSpeed: 900 } })).resolves.toMatchObject({
        ok: true,
        value: { properties: { MaxWalkSpeed: 900 } },
      });
      await expect(agent("playtest.start")).resolves.toMatchObject({ ok: true });
      await waitFor(core, () => (core.registry.session(session.sessionId)?.playState === "playing" ? true : null));
      const tests = await agent("tests.run", { filter: "Project.Inventory" });
      expect(tests).toMatchObject({ ok: true, value: { passed: 1, failed: 1 } });
      const capture = await agent("viewport.capture", { width: 64, height: 64 });
      expect(capture.captureId).not.toBeNull();
      expect(await NodeFSP.readFile(await core.captureToFile(capture.captureId!))).toBeInstanceOf(Buffer);
      await agent("playtest.stop");

      const errors = core.registry.logs(session.sessionId, { levels: ["error"], contains: "Expected 3", limit: 10, playtest: null });
      expect(errors).toHaveLength(1);
      const timeline = (await core.workspace(project)).timeline.map((entry) => entry.kind);
      expect(timeline).toEqual(expect.arrayContaining(["connection", "agent-action", "user-action", "play-state", "capture", "error"]));

      const checkpoint = await core.checkpointCreate({ projectRoot: project, label: "Before level edit", createdBy: "agent" });
      await NodeFSP.writeFile(NodePath.join(project, "Content", "Maps", "Main.umap"), "level-v2");
      expect((await core.checkpointDiff(project, checkpoint.checkpointId)).changes).toMatchObject([{ path: "Content/Maps/Main.umap", change: "modified" }]);

      if (blender !== null) {
        await core.blender({ projectRoot: project, assetId: "crate", name: "Crate", operation: "create_mesh", args: { name: "Crate", primitive: "cube", size: 1, scale: [1, 1, 0.5] }, fresh: true });
        await core.blender({ projectRoot: project, assetId: "crate", operation: "modify", args: { object: "Crate", applyTransforms: true } });
        await core.blender({ projectRoot: project, assetId: "crate", operation: "material", args: { object: "Crate", name: "Wood", baseColor: [0.55, 0.35, 0.15] } });
        const saved = await core.saveBlenderRevision({ projectRoot: project, assetId: "crate", target: "unreal", note: "First pass", brief: { description: "Crate", style: "stylized", dimensions: { x: 1, y: 1, z: 0.5, units: "m" }, textureResolution: null, polygonBudget: 500, referenceImages: [], targetEngine: "unreal" }, createdBy: "agent" });
        expect(saved.revision.files.map((file) => file.role)).toEqual(["source", "export", "preview"]);
        expect(saved.revision.checks.every((check) => check.status !== "fail")).toBe(true);
        const imported = await core.assetImport({ projectRoot: project, assetId: "crate", revision: 1, confirmReplace: false, actor: "agent", threadId: "thread-1", place: { label: "Crate" } });
        expect(imported.import).toMatchObject({ status: "imported", location: "Crate" });
        expect(imported.import?.checks.find((check) => check.name === "Scale in engine")).toMatchObject({ status: "pass" });
        expect(imported.import?.checks.find((check) => check.name === "Orientation (up axis)")).toMatchObject({ status: "pass" });
      }
    } finally {
      editor.kill();
      await core.stop();
    }
    expect(stderr).not.toContain("Traceback");
  });
});
