import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import { settleProjectScript, setupProjectScript } from "@t3tools/shared/projectScripts";

import {
  commandForProjectScript,
  copyProjectScripts,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptContentsEqual,
  releaseClaimedRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
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

  it("copies action behavior while retaining destination shortcuts by action name", () => {
    const source = [
      {
        id: "source-setup",
        name: "Setup",
        command: "vp i",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
        async: false,
      },
      {
        id: "source-dev",
        name: "Dev",
        command: "vp run dev",
        icon: "play" as const,
        runOnWorktreeCreate: false,
        stopOnSettle: true,
        previewUrl: "http://localhost:3000",
        autoOpenPreview: true,
      },
    ];
    const destination = [
      { ...source[0]!, id: "local-setup", name: "SETUP", command: "old setup" },
      { ...source[0]!, id: "obsolete", name: "Obsolete" },
    ];
    const copied = copyProjectScripts(source, destination, ["dev", "dev-2", "local-setup"]);

    expect(copied).toEqual([
      { ...source[0], id: "local-setup" },
      { ...source[1], id: "dev-3" },
    ]);
    expect(
      copyProjectScripts(
        source,
        copied,
        copied.map((script) => script.id),
      ),
    ).toEqual(copied);
    expect(projectScriptContentsEqual(source, copied)).toBe(true);
    expect(projectScriptContentsEqual(source, destination)).toBe(false);
    expect(copyProjectScripts([], destination, [])).toEqual([]);
    expect(destination[0]!.command).toBe("old setup");
  });

  it("allocates distinct shortcut IDs for copied actions with the same name", () => {
    const script = {
      id: "source",
      name: "Dev",
      command: "vp run dev",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    expect(
      copyProjectScripts([script, script], [{ ...script, id: "local" }], ["local", "dev"]).map(
        (copied) => copied.id,
      ),
    ).toEqual(["local", "dev-2"]);
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
