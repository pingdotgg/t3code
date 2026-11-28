import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  projectScriptFileCommand,
  projectScriptForFile,
  settleProjectScript,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdsInEnvironment,
  releaseClaimedRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it.each([
    ["scripts/build.sh", 'sh "./scripts/build.sh"'],
    ["Bob's scripts/build & check.js", 'node "./Bob\'s scripts/build & check.js"'],
    ["-check.py", 'python3 "./-check.py"'],
    ["README.md", null],
    ["sh", null],
    ["file.constructor", null],
    ["file.toString", null],
    ["scripts/BUILD.SH", 'sh "./scripts/BUILD.SH"'],
    ["scripts/$(touch pwned).sh", null],
    ["scripts/%PATH%.sh", null],
    ["scripts/`id`.sh", null],
    ['scripts/a".sh', null],
    ["scripts/line\nbreak.sh", null],
    ["../outside.sh", null],
    ["/absolute.sh", null],
  ])("only offers an interpreter command for a safe script path %s", (path, command) => {
    expect(projectScriptFileCommand(path)).toBe(command);
    const script = projectScriptForFile(path);
    if (command === null) expect(script).toBeNull();
    else expect(script).toMatchObject({ command, runOnWorktreeCreate: false, icon: "play" });
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("avoids script ids another project in the environment uses", () => {
    const script = (id: string) => ({
      id,
      name: id,
      command: id,
      icon: "test" as const,
      runOnWorktreeCreate: false,
    });
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      projectSettingsFolded: false,
      defaultProjectScripts: [script("lint")],
      projectSettingsOverrides: {
        [ProjectId.make("a")]: { defaultProjectScripts: [script("test")] },
      },
    };
    const ids = projectScriptIdsInEnvironment(settings, [
      { id: ProjectId.make("b"), scripts: [script("build")] },
    ]);
    expect(new Set(ids)).toEqual(new Set(["lint", "test", "build"]));
    expect(nextProjectScriptId("Test", ids)).toBe("test-2");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };

    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: true, runOnSettle: false }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: false }),
    ).toBe(holder);
  });
});
