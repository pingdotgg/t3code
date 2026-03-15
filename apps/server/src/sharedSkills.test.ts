import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  getSharedSkillsState,
  initializeSharedSkills,
  setSharedSkillEnabled,
  uninstallSharedSkill,
} from "./sharedSkills";

const tempDirectories: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(dir);
  return dir;
}

async function writeSkill(rootPath: string, name: string, description = `${name} description`) {
  const skillPath = path.join(rootPath, name);
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(
    path.join(skillPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
  return skillPath;
}

async function writeSystemSkill(
  codexHomePath: string,
  name: string,
  description = `${name} description`,
) {
  const systemRoot = path.join(codexHomePath, "skills", ".system");
  await fs.mkdir(systemRoot, { recursive: true });
  await fs.writeFile(path.join(systemRoot, ".codex-system-skills.marker"), "marker\n", "utf8");
  return writeSkill(systemRoot, name, description);
}

async function withTempHome<T>(
  prefix: string,
  callback: (homePath: string) => Promise<T>,
): Promise<T> {
  const homePath = await makeTempDir(prefix);
  process.env.HOME = homePath;
  process.env.USERPROFILE = homePath;

  try {
    return await callback(homePath);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  }
}

async function useIsolatedHome(): Promise<string> {
  const homePath = await makeTempDir("t3-home-");
  process.env.HOME = homePath;
  process.env.USERPROFILE = homePath;
  return homePath;
}

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  await Promise.all(
    tempDirectories.splice(0).map((dir) =>
      fs.rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("sharedSkills", () => {
  it("initializes shared skills by moving Codex user skills and replacing them with symlinks", async () => {
    await useIsolatedHome();
    const codexHomePath = await makeTempDir("t3-codex-home-");
    const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");

    await writeSkill(path.join(codexHomePath, "skills"), "demo");

    const result = await initializeSharedSkills({
      codexHomePath,
      sharedSkillsPath,
    });

    expect(result.isInitialized).toBe(true);
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "demo",
        status: "managed",
        codexPathExists: true,
        sharedPathExists: true,
        symlinkedToSharedPath: true,
      }),
    ]);

    const codexSkillPath = path.join(codexHomePath, "skills", "demo");
    const codexStat = await fs.lstat(codexSkillPath);
    expect(codexStat.isSymbolicLink()).toBe(true);
    expect(await fs.realpath(codexSkillPath)).toBe(
      await fs.realpath(path.join(sharedSkillsPath, "demo")),
    );
    await expect(fs.stat(path.join(sharedSkillsPath, "demo", "SKILL.md"))).resolves.toBeDefined();
  });

  it("surfaces newly discovered skills after initialization until they are explicitly moved", async () => {
    await useIsolatedHome();
    const codexHomePath = await makeTempDir("t3-codex-home-");
    const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");

    await initializeSharedSkills({
      codexHomePath,
      sharedSkillsPath,
    });

    await writeSkill(path.join(codexHomePath, "skills"), "later");

    const result = await getSharedSkillsState({
      codexHomePath,
      sharedSkillsPath,
    });

    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "later",
        status: "needs-migration",
        codexPathExists: true,
        sharedPathExists: false,
        symlinkedToSharedPath: false,
      }),
    ]);

    const movedState = await initializeSharedSkills({
      codexHomePath,
      sharedSkillsPath,
    });

    expect(movedState.skills).toEqual([
      expect.objectContaining({
        name: "later",
        status: "managed",
        codexPathExists: true,
        sharedPathExists: true,
        symlinkedToSharedPath: true,
      }),
    ]);
  });

  it("initializes nested Codex skills such as .system skills", async () => {
    await useIsolatedHome();
    const codexHomePath = await makeTempDir("t3-codex-home-");
    const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");

    await writeSystemSkill(codexHomePath, "skill-creator", "system skill");

    const result = await initializeSharedSkills({
      codexHomePath,
      sharedSkillsPath,
    });

    expect(result.skills).toEqual([
      expect.objectContaining({
        name: ".system/skill-creator",
        status: "managed",
        enabled: true,
        codexPathExists: true,
        sharedPathExists: true,
        symlinkedToSharedPath: true,
      }),
    ]);

    const codexSkillPath = path.join(codexHomePath, "skills", ".system", "skill-creator");
    expect(await fs.realpath(codexSkillPath)).toBe(
      await fs.realpath(path.join(sharedSkillsPath, ".system", "skill-creator")),
    );
    await expect(
      fs.readFile(path.join(codexHomePath, "skills", ".system", ".codex-system-skills.marker")),
    ).resolves.toBeDefined();
  });

  it("finds and initializes user-installed skills from ~/.agents/skills", async () => {
    await withTempHome("t3-home-", async (homePath) => {
      const codexHomePath = path.join(homePath, ".codex");
      const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");

      await writeSkill(path.join(homePath, ".agents", "skills"), "agent-browser");

      const beforeInit = await getSharedSkillsState({
        codexHomePath,
        sharedSkillsPath,
      });

      expect(beforeInit.skills).toEqual([
        expect.objectContaining({
          name: "agent-browser",
          status: "needs-migration",
          enabled: true,
          codexPathExists: true,
          sharedPathExists: false,
        }),
      ]);

      const initialized = await initializeSharedSkills({
        codexHomePath,
        sharedSkillsPath,
      });

      expect(initialized.skills).toEqual([
        expect.objectContaining({
          name: "agent-browser",
          status: "managed",
          enabled: true,
          codexPathExists: true,
          sharedPathExists: true,
          symlinkedToSharedPath: true,
        }),
      ]);

      expect(await fs.realpath(path.join(homePath, ".agents", "skills", "agent-browser"))).toBe(
        await fs.realpath(path.join(sharedSkillsPath, "agent-browser")),
      );
    });
  });

  it("surfaces broken harness skill symlinks after initialization", async () => {
    await withTempHome("t3-home-", async (homePath) => {
      const codexHomePath = path.join(homePath, ".codex");
      const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");

      await initializeSharedSkills({
        codexHomePath,
        sharedSkillsPath,
      });

      const agentsSkillsPath = path.join(homePath, ".agents", "skills");
      await fs.mkdir(agentsSkillsPath, { recursive: true });
      await fs.symlink(
        path.join(homePath, "missing-skill"),
        path.join(agentsSkillsPath, "agent-browser"),
        "dir",
      );

      const state = await getSharedSkillsState({
        codexHomePath,
        sharedSkillsPath,
      });

      expect(state.skills).toEqual([
        expect.objectContaining({
          name: "agent-browser",
          status: "broken-link",
          enabled: false,
          codexPathExists: true,
          sharedPathExists: false,
        }),
      ]);
      expect(state.warnings).toContain(
        "Skill 'agent-browser' points to a missing directory and could not be migrated. Restore or reinstall it, then click Move skills.",
      );
    });
  });

  it("ignores empty icon paths in skill manifests", async () => {
    await useIsolatedHome();
    const codexHomePath = await makeTempDir("t3-codex-home-");
    const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");
    const skillPath = await writeSkill(path.join(codexHomePath, "skills"), "demo");

    await fs.writeFile(
      path.join(skillPath, "SKILL.json"),
      JSON.stringify({
        interface: {
          iconSmall: "",
        },
      }),
      "utf8",
    );

    const state = await getSharedSkillsState({
      codexHomePath,
      sharedSkillsPath,
    });

    expect(state.skills).toHaveLength(1);
    expect(state.skills[0]?.name).toBe("demo");
    expect(state.skills[0]?.iconPath).toBeUndefined();
    expect(state.skills[0]?.iconPath).not.toBe(skillPath);
  });

  it("ignores file symlinks while scanning skills", async () => {
    await useIsolatedHome();
    const codexHomePath = await makeTempDir("t3-codex-home-");
    const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");
    const codexSkillsPath = path.join(codexHomePath, "skills");

    await fs.mkdir(codexSkillsPath, { recursive: true });
    await writeSkill(codexSkillsPath, "demo");
    await fs.writeFile(path.join(codexHomePath, "not-a-skill.txt"), "hello\n", "utf8");
    await fs.symlink(
      path.join(codexHomePath, "not-a-skill.txt"),
      path.join(codexSkillsPath, "file-link"),
    );

    const state = await getSharedSkillsState({
      codexHomePath,
      sharedSkillsPath,
    });

    expect(state.skills).toEqual([
      expect.objectContaining({
        name: "demo",
      }),
    ]);
  });

  it("keeps disabled skills hidden from Codex across refreshes", async () => {
    await useIsolatedHome();
    const codexHomePath = await makeTempDir("t3-codex-home-");
    const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");

    await writeSkill(path.join(codexHomePath, "skills"), "demo");
    await initializeSharedSkills({
      codexHomePath,
      sharedSkillsPath,
    });

    const disabledState = await setSharedSkillEnabled({
      codexHomePath,
      sharedSkillsPath,
      skillName: "demo",
      enabled: false,
    });

    expect(disabledState.skills).toEqual([
      expect.objectContaining({
        name: "demo",
        enabled: false,
        status: "needs-link",
        codexPathExists: false,
        sharedPathExists: true,
      }),
    ]);

    await expect(fs.lstat(path.join(codexHomePath, "skills", "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const refreshedState = await getSharedSkillsState({
      codexHomePath,
      sharedSkillsPath,
    });

    expect(refreshedState.skills).toEqual([
      expect.objectContaining({
        name: "demo",
        enabled: false,
        status: "needs-link",
        codexPathExists: false,
      }),
    ]);
  });

  it("uninstalls a managed shared skill from both locations", async () => {
    await useIsolatedHome();
    const codexHomePath = await makeTempDir("t3-codex-home-");
    const sharedSkillsPath = path.join(await makeTempDir("t3-shared-skills-"), "skills");

    await writeSkill(path.join(codexHomePath, "skills"), "demo");
    await initializeSharedSkills({
      codexHomePath,
      sharedSkillsPath,
    });

    const result = await uninstallSharedSkill({
      codexHomePath,
      sharedSkillsPath,
      skillName: "demo",
    });

    expect(result.skills).toEqual([]);
    await expect(fs.lstat(path.join(codexHomePath, "skills", "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.lstat(path.join(sharedSkillsPath, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
