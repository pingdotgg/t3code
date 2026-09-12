// @effect-diagnostics nodeBuiltinImport:off -- Isolated config fixtures, never the user's desktop.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { afterEach, beforeEach, expect, it as test, vi } from "vite-plus/test";
import { CaptureShortcutConfig, niriCaptureConfigPath } from "./CaptureShortcutConfig.ts";
import { captureConfigBinding } from "./captureConfigEdit.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Test collection checks the host before starting these Linux-native filesystem tests.
const it = test.runIf(process.platform === "linux");
let directory: string;
let path: string;
let setup: CaptureShortcutConfig;
const tools = {
  validateNiri: vi.fn<(path: string) => Promise<void>>(),
  hyprlandBindings:
    vi.fn<() => Promise<{ modmask: number; key: string; dispatcher: string; arg: string }[]>>(),
  reloadHyprland: vi.fn<() => Promise<void>>(),
};
const appId = "com.t3tools.T3Code";
const install = { operation: "install", chooseFile: false } as const;
const target = () => ({ desktop: "niri" as const, path, appId });
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-capture-config-"));
  path = NodePath.join(directory, "config.kdl");
  await NodeFSP.writeFile(path, "binds {\n    Mod+Q { quit; }\n}\n", { mode: 0o640 });
  tools.validateNiri.mockReset().mockResolvedValue(undefined);
  tools.hyprlandBindings.mockReset().mockResolvedValue([]);
  tools.reloadHyprland.mockReset().mockResolvedValue(undefined);
  setup = new CaptureShortcutConfig(tools);
});
afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

it("reads without writing, then applies only the approved diff with a backup", async () => {
  const before = await NodeFSP.readFile(path, "utf8");
  const preview = await setup.preview(target(), install);
  expect(await NodeFSP.readFile(path, "utf8")).toBe(before);
  expect(await NodeFSP.readdir(directory)).toEqual(["config.kdl"]);
  expect(tools.validateNiri).not.toHaveBeenCalled();
  expect(preview.before).toBe(before);
  expect(preview.after).toContain("Ctrl+Shift+2");
  const applied = await setup.apply(preview.id, "niri");
  expect(await NodeFSP.readFile(path, "utf8")).toBe(preview.after);
  expect(await NodeFSP.readFile(applied.backupPath!, "utf8")).toBe(before);
  expect((await NodeFSP.stat(path)).mode & 0o777).toBe(0o640);
  expect(tools.validateNiri).toHaveBeenCalledOnce();
  await expect(setup.apply(preview.id, "niri")).rejects.toThrow("expired");
});
it("refuses apply without a preview or for the wrong desktop", async () => {
  await expect(setup.apply("invented", "niri")).rejects.toThrow("expired");
  const preview = await setup.preview(target(), install);
  await expect(setup.apply(preview.id, "hyprland")).rejects.toThrow("expired");
  expect(await NodeFSP.readFile(path, "utf8")).toBe(preview.before);
});
it("rechecks Hyprland conflicts before writing", async () => {
  const hypr = {
    ...target(),
    desktop: "hyprland" as const,
    path: NodePath.join(directory, "hyprland.conf"),
  };
  await NodeFSP.writeFile(hypr.path, "# unchanged\n");
  const preview = await setup.preview(hypr, install);
  tools.hyprlandBindings.mockResolvedValue([
    { modmask: 5, key: "2", dispatcher: "exec", arg: "kitty" },
  ]);
  await expect(setup.apply(preview.id, "hyprland")).rejects.toThrow("already used");
  expect(await NodeFSP.readFile(hypr.path, "utf8")).toBe(preview.before);
});
it("notices an optional include created while the diff is open", async () => {
  await NodeFSP.appendFile(path, 'include optional=true "later.kdl"\n');
  const preview = await setup.preview(target(), install);
  await NodeFSP.writeFile(
    NodePath.join(directory, "later.kdl"),
    "binds {\n Ctrl+Shift+2 { quit; }\n}\n",
  );
  await expect(setup.apply(preview.id, "niri")).rejects.toThrow("changed since");
  expect(await NodeFSP.readFile(path, "utf8")).toBe(preview.before);
});
it("invalidates an earlier proposal when another config is opened", async () => {
  const first = await setup.preview(target(), install);
  await setup.preview(target(), { ...install, shortcut: "Ctrl+Alt+Y" });
  await expect(setup.apply(first.id, "niri")).rejects.toThrow("expired");
});
it("does not overwrite edits made after preview", async () => {
  const preview = await setup.preview(target(), install);
  await NodeFSP.appendFile(path, "// edited elsewhere\n");
  await expect(setup.apply(preview.id, "niri")).rejects.toThrow("changed since");
  expect(await NodeFSP.readFile(path, "utf8")).toBe(preview.before + "// edited elsewhere\n");
  expect(await NodeFSP.readdir(directory)).toEqual(["config.kdl"]);
});
it("rechecks after validation and cleans the staged file on concurrent edits", async () => {
  const preview = await setup.preview(target(), install);
  tools.validateNiri.mockImplementation(async () => {
    await NodeFSP.appendFile(path, "// keep this\n");
  });
  await expect(setup.apply(preview.id, "niri")).rejects.toThrow("changed since");
  expect(await NodeFSP.readdir(directory)).toEqual(["config.kdl"]);
  expect(await NodeFSP.readFile(path, "utf8")).toContain("keep this");
});
it("preserves symlink-managed dotfiles and identifies their actual target", async () => {
  const link = NodePath.join(directory, "linked.kdl");
  await NodeFSP.symlink(path, link);
  const preview = await setup.preview({ ...target(), path: link }, install);
  expect(preview.path).toBe(link);
  expect(preview.resolvedPath).toBe(path);
  await setup.apply(preview.id, "niri");
  expect((await NodeFSP.lstat(link)).isSymbolicLink()).toBe(true);
  expect(await NodeFSP.readFile(link, "utf8")).toBe(preview.after);
});
it("refuses a symlink retargeted since preview", async () => {
  const link = NodePath.join(directory, "linked.kdl");
  const other = NodePath.join(directory, "other.kdl");
  await NodeFSP.writeFile(other, "binds {}\n");
  await NodeFSP.symlink(path, link);
  const preview = await setup.preview({ ...target(), path: link }, install);
  await NodeFSP.unlink(link);
  await NodeFSP.symlink(other, link);
  await expect(setup.apply(preview.id, "niri")).rejects.toThrow("changed since");
  expect(await NodeFSP.readFile(other, "utf8")).toBe("binds {}\n");
});
it("validates symlinked configs from their original directory so relative includes stay valid", async () => {
  const active = NodePath.join(directory, "active");
  await NodeFSP.mkdir(active);
  const link = NodePath.join(active, "config.kdl");
  await NodeFSP.symlink(path, link);
  await NodeFSP.appendFile(path, 'include "keys.kdl"\n');
  await NodeFSP.writeFile(NodePath.join(active, "keys.kdl"), "binds {}\n");
  tools.validateNiri.mockImplementation(async (file) => {
    expect(NodePath.dirname(file)).toBe(active);
    expect(await NodeFSP.readFile(file, "utf8")).toContain("Ctrl+Shift+2");
    expect(await NodeFSP.readFile(NodePath.join(NodePath.dirname(file), "keys.kdl"), "utf8")).toBe(
      "binds {}\n",
    );
  });
  const preview = await setup.preview({ ...target(), path: link }, install);
  await setup.apply(preview.id, "niri");
  expect((await NodeFSP.readdir(active)).sort()).toEqual(["config.kdl", "keys.kdl"]);
  expect((await NodeFSP.lstat(link)).isSymbolicLink()).toBe(true);
});
it("does not apply invalid Niri configs", async () => {
  const preview = await setup.preview(target(), install);
  tools.validateNiri.mockRejectedValue(new Error("Invalid config"));
  await expect(setup.apply(preview.id, "niri")).rejects.toThrow("Invalid config");
  expect(await NodeFSP.readFile(path, "utf8")).toBe(preview.before);
  expect(await NodeFSP.readdir(directory)).toEqual(["config.kdl"]);
});
it("leaves already configured files unchanged, without creating a backup", async () => {
  await NodeFSP.writeFile(path, `binds { ${captureConfigBinding("niri", appId, "Ctrl+Alt+Y")} }`);
  const preview = await setup.preview(target(), install);
  expect(preview.after).toBe(preview.before);
  expect(preview.shortcut).toBe("Ctrl+Alt+Y");
  expect(await setup.apply(preview.id, "niri")).toEqual({ backupPath: null, warning: null });
  expect(await NodeFSP.readdir(directory)).toEqual(["config.kdl"]);
});
it("detects conflicts in included Niri configs without changing either file", async () => {
  await NodeFSP.appendFile(path, 'include "keys.kdl"\n');
  await NodeFSP.writeFile(NodePath.join(directory, "keys.kdl"), "binds { Shift+Ctrl+2 { quit; } }");
  await expect(setup.preview(target(), install)).rejects.toThrow("already used");
  expect((await NodeFSP.readdir(directory)).sort()).toEqual(["config.kdl", "keys.kdl"]);
});
it("detects included config changes before applying", async () => {
  await NodeFSP.appendFile(path, 'include "keys.kdl"\n');
  const included = NodePath.join(directory, "keys.kdl");
  await NodeFSP.writeFile(included, "binds { Ctrl+Alt+Q { quit; } }");
  const preview = await setup.preview(target(), install);
  await NodeFSP.writeFile(included, "binds { Ctrl+Shift+2 { quit; } }");
  await expect(setup.apply(preview.id, "niri")).rejects.toThrow("changed since");
});
it("rejects a conflict from another Hyprland config or dynamic Lua bind", async () => {
  const hypr = {
    ...target(),
    desktop: "hyprland" as const,
    path: NodePath.join(directory, "bindings.lua"),
  };
  await NodeFSP.writeFile(hypr.path, "-- user bindings\n");
  tools.hyprlandBindings.mockResolvedValue([
    { modmask: 5, key: "2", dispatcher: "exec", arg: "kitty" },
  ]);
  await expect(setup.preview(hypr, install)).rejects.toThrow("already used");
  expect(await NodeFSP.readFile(hypr.path, "utf8")).toBe("-- user bindings\n");
});
it("reloads Hyprland after apply, but not after read", async () => {
  const hypr = {
    ...target(),
    desktop: "hyprland" as const,
    path: NodePath.join(directory, "hyprland.conf"),
  };
  await NodeFSP.writeFile(hypr.path, "# preferences\n");
  const preview = await setup.preview(hypr, install);
  expect(tools.reloadHyprland).not.toHaveBeenCalled();
  await setup.apply(preview.id, "hyprland");
  expect(tools.reloadHyprland).toHaveBeenCalledOnce();
});
it("reports reload failure separately from a successfully saved config", async () => {
  const hypr = {
    ...target(),
    desktop: "hyprland" as const,
    path: NodePath.join(directory, "hyprland.conf"),
  };
  await NodeFSP.writeFile(hypr.path, "# preferences\n");
  const preview = await setup.preview(hypr, install);
  tools.reloadHyprland.mockRejectedValue(new Error("Compositor stopped"));
  const result = await setup.apply(preview.id, "hyprland");
  expect(result.warning).toContain("Config saved");
  expect(await NodeFSP.readFile(hypr.path, "utf8")).toBe(preview.after);
});
it("does not edit Omarchy's shipped defaults", async () => {
  const defaults = NodePath.join(directory, "omarchy", "default", "hypr");
  await NodeFSP.mkdir(defaults, { recursive: true });
  const file = NodePath.join(defaults, "bindings.conf");
  await NodeFSP.writeFile(file, "# defaults\n");
  await expect(
    setup.preview({ ...target(), desktop: "hyprland", path: file }, install),
  ).rejects.toThrow("not system or Omarchy");
});
it("honors NIRI_CONFIG and XDG_CONFIG_HOME", () => {
  expect(
    niriCaptureConfigPath(
      { NIRI_CONFIG: "/custom/test.kdl", XDG_CONFIG_HOME: "/config" },
      "/home/test",
    ),
  ).toBe("/custom/test.kdl");
  expect(niriCaptureConfigPath({ XDG_CONFIG_HOME: "/config" }, "/home/test")).toBe(
    "/config/niri/config.kdl",
  );
  expect(niriCaptureConfigPath({}, "/home/test")).toBe("/home/test/.config/niri/config.kdl");
});
it("preserves a UTF-8 BOM through preview and apply", async () => {
  await NodeFSP.writeFile(path, "\uFEFFbinds {}\r\n");
  const preview = await setup.preview(target(), install);
  await setup.apply(preview.id, "niri");
  expect((await NodeFSP.readFile(path)).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
});
it("the installed Niri parser accepts the generated edit and its relative includes", async (context) => {
  try {
    await NodeUtil.promisify(NodeChildProcess.execFile)("niri", ["--version"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      context.skip();
      return;
    }
    throw error;
  }
  // No compositor is launched: validate only parses the temporary fixture.
  await NodeFSP.appendFile(path, 'include "keys.kdl"\n');
  await NodeFSP.writeFile(
    NodePath.join(directory, "keys.kdl"),
    "binds {\n    Ctrl+Alt+Q { quit; }\n}\n",
  );
  const checked = new CaptureShortcutConfig({
    ...tools,
    validateNiri: async (file) => {
      await NodeUtil.promisify(NodeChildProcess.execFile)("niri", ["validate", "--config", file]);
    },
  });
  const preview = await checked.preview(target(), install);
  await checked.apply(preview.id, "niri");
  expect(await NodeFSP.readFile(path, "utf8")).toBe(preview.after);
});
