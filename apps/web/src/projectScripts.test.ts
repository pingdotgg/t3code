import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { settleProjectScript, setupProjectScript } from "@t3tools/shared/projectScripts";

import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
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

it("creates and edits prompt actions without shell settings or claiming lifecycle roles", () => {
  const input = {
    type: "prompt",
    prompt: "Read project instructions and report status.",
    command: "echo old shell",
    name: "Status",
    icon: "debug",
    runOnWorktreeCreate: true,
    waitForSetup: true,
    runOnSettle: true,
    previewUrl: "http://localhost:3000",
    autoOpenPreview: true,
  } as const;
  const action = buildProjectScript("status", input);
  expect(action).toEqual({
    id: "status",
    name: "Status",
    type: "prompt",
    prompt: input.prompt,
    icon: "debug",
    runOnWorktreeCreate: false,
  });
  expect(setupProjectScript([action])).toBeNull();
  expect(settleProjectScript([action])).toBeNull();
  expect(
    buildProjectScript(action.id, { ...input, name: "Updated", prompt: "Read new outputs." }),
  ).toMatchObject({ id: "status", name: "Updated", prompt: "Read new outputs." });
  const modelSelection = {
    instanceId: ProviderInstanceId.make("custom-provider"),
    model: "deepseek/deepseek-v4.1-flash:free",
    options: [{ id: "reasoningEffort", value: "max" as const }],
  };
  expect(buildProjectScript("status", { ...input, modelSelection })).toMatchObject({
    modelSelection,
  });
  const shell = buildProjectScript("shell", { ...input, type: "shell" });
  expect(shell).toMatchObject({
    command: "echo old shell",
    runOnWorktreeCreate: true,
    async: false,
    runOnSettle: true,
    previewUrl: input.previewUrl,
    autoOpenPreview: true,
  });
  expect(shell).not.toHaveProperty("prompt");
  expect(releaseClaimedRoles(shell, input)).toBe(shell);
});
