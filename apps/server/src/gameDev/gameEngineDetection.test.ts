// @effect-diagnostics nodeBuiltinImport:off - Builds fake vendor install folders on a temporary disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { detectInstalls, detectProjects } from "./gameEngineDetection.ts";

async function touch(path: string, contents = "") {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, contents);
  await NodeFSP.chmod(path, 0o755);
}

describe("game engine detection", () => {
  it("finds Unity Hub editors, Unreal builds from Install.ini, and Continuum's Blender on Linux", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-home-"));
    await touch(NodePath.join(home, "Unity/Hub/Editor/2022.3.20f1/Editor/Unity"));
    await touch(NodePath.join(home, "Unity/Hub/Editor/6000.3.29f1/Editor/Unity"));
    await touch(NodePath.join(home, "Unity/Hub/Editor/not-a-version/Editor/Unity"));
    const secondary = NodePath.join(home, "SecondDrive");
    await touch(NodePath.join(secondary, "6000.0.58f2/Editor/Unity"));
    await touch(NodePath.join(home, ".config/UnityHub/secondaryInstallPath.json"), JSON.stringify(secondary));
    const ue = NodePath.join(home, "Engines/UE_5.6");
    await touch(NodePath.join(ue, "Engine/Binaries/Linux/UnrealEditor"));
    await touch(NodePath.join(ue, "Engine/Build/Build.version"), JSON.stringify({ MajorVersion: 5, MinorVersion: 6, PatchVersion: 1 }));
    await touch(NodePath.join(home, ".config/Epic/UnrealEngine/Install.ini"), `[Installations]\n{GUID}=${ue}\n`);
    const tools = NodePath.join(home, ".continuum/tools");
    const blender = NodePath.join(tools, "blender/5.3.0/blender");
    await touch(blender, "#!/bin/sh\necho 'Blender 5.3.0'\n");

    const found = await detectInstalls({ platform: "linux", paths: { home }, toolsDir: tools, pathDirs: [] }, []);
    expect(found.unity.map((install) => install.version)).toEqual(["6000.3.29f1", "6000.0.58f2", "2022.3.20f1"]);
    expect(found.unreal).toEqual([{ target: "unreal", version: "5.6.1", path: NodePath.join(ue, "Engine/Binaries/Linux/UnrealEditor"), source: "detected" }]);
    expect(found.blender).toMatchObject({ version: "5.3.0", source: "managed" });
    expect(found.roblox).toEqual([]);
  });

  it("recognizes engine projects and their pinned versions one level down", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-projects-"));
    await touch(NodePath.join(root, "game/ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 2022.3.20f1\nm_EditorVersionWithRevision: 2022.3.20f1 (61c2feb0970d)\n");
    await NodeFSP.mkdir(NodePath.join(root, "game/Assets"), { recursive: true });
    await touch(NodePath.join(root, "shooter/Shooter.uproject"), JSON.stringify({ EngineAssociation: "5.4" }));
    await touch(NodePath.join(root, "shooter/Plugins/ContinuumBridge/ContinuumBridge.uplugin"), "{}");
    await touch(NodePath.join(root, "obby/default.project.json"), "{}");
    const projects = await detectProjects(root);
    expect(projects.map((project) => [project.engine, project.name, project.pinnedVersion, project.pinnedRevision, project.bridgeInstalled])).toEqual([
      ["unity", "game", "2022.3.20f1", "61c2feb0970d", false],
      ["roblox", "obby", null, null, false],
      ["unreal", "Shooter", "5.4", null, true],
    ]);
  });
});
