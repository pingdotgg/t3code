// @effect-diagnostics nodeBuiltinImport:off -- Native, consent-gated compositor config I/O.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import type {
  DesktopCaptureConfigApplied,
  DesktopCaptureConfigPreview,
  DesktopCaptureConfigRequest,
} from "@t3tools/contracts";
import {
  captureConfigKeys,
  editCaptureConfig,
  niriConfigConflict,
  niriConfigIncludes,
  type CaptureConfigFormat,
} from "./captureConfigEdit.ts";

const execute = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) =>
  NodeUtil.promisify(NodeChildProcess.execFile)(file, args, options);
const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 64;
type Target = { desktop: "niri" | "hyprland"; path: string; appId: string };
type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
const decodeHyprlandBindings = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        modmask: Schema.Number,
        key: Schema.String,
        dispatcher: Schema.String,
        arg: Schema.String,
      }),
    ),
  ),
);

export function niriCaptureConfigPath(env = process.env, home = NodeOS.homedir()) {
  return (
    env.NIRI_CONFIG ||
    NodePath.join(env.XDG_CONFIG_HOME || NodePath.join(home, ".config"), "niri", "config.kdl")
  );
}

async function readSnapshot(path: string) {
  const resolvedPath = await NodeFSP.realpath(path);
  const file = await NodeFSP.open(
    resolvedPath,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("Choose a config file smaller than 1 MB.");
    const bytes = await file.readFile();
    if (bytes.length > MAX_BYTES) throw new Error("Choose a config file smaller than 1 MB.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Choose a text config file.");
    return { path, resolvedPath, text, bytes, stat };
  } finally {
    await file.close();
  }
}

const defaultTools = {
  validateNiri: async (path: string) => {
    try {
      await execute("niri", ["validate", "--config", path], {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      throw new Error(
        "Niri couldn't validate the proposed config. Nothing was changed. Check your config in Advanced.",
      );
    }
  },
  hyprlandBindings: async () =>
    decodeHyprlandBindings(
      (await execute("hyprctl", ["-j", "binds"], { timeout: 5000, maxBuffer: MAX_BYTES })).stdout,
    ),
  reloadHyprland: async () => {
    await execute("hyprctl", ["reload"], { timeout: 5000, maxBuffer: 64 * 1024 });
    const errors = await execute("hyprctl", ["configerrors"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    if (errors.stdout.trim()) throw new Error("Hyprland reported config errors.");
  },
};

/** The renderer can apply only the exact proposal retained by the desktop process. */
export class CaptureShortcutConfig {
  private pending:
    | { preview: DesktopCaptureConfigPreview; target: Target; files: Snapshot[]; missing: string[] }
    | undefined;
  private applying = false;
  private readonly tools: typeof defaultTools;
  constructor(tools = defaultTools) {
    this.tools = tools;
  }

  private async checkHyprlandKeys(appId: string, shortcut: string) {
    const keys = captureConfigKeys(shortcut);
    const bindings = await this.tools.hyprlandBindings().catch(() => {
      throw new Error(
        "Couldn't check Hyprland's current shortcuts. Try again from your Hyprland session.",
      );
    });
    if (
      bindings.some(
        (binding) =>
          binding.modmask === keys.mask &&
          binding.key.toUpperCase() === keys.key &&
          !(binding.dispatcher === "global" && binding.arg === `${appId}:capture-window`),
      )
    )
      throw new Error(`${keys.label} is already used by Hyprland. Choose another shortcut.`);
  }

  async preview(
    target: Target,
    request: DesktopCaptureConfigRequest,
  ): Promise<DesktopCaptureConfigPreview> {
    if (this.applying) throw new Error("Wait for the current config change to finish.");
    this.pending = undefined;
    const root = await readSnapshot(target.path).catch(() => {
      throw new Error("Couldn't read your settings file. Choose a different file in Advanced.");
    });
    if (root.stat.uid !== process.getuid?.() || /\/omarchy\/default\//.test(root.resolvedPath))
      throw new Error("Choose your own config, not system or Omarchy defaults.");
    const format: CaptureConfigFormat =
      target.desktop === "niri"
        ? "niri"
        : target.path.endsWith(".lua")
          ? "hyprland-lua"
          : "hyprland";
    if (
      !target.path.endsWith(
        format === "niri" ? ".kdl" : format === "hyprland-lua" ? ".lua" : ".conf",
      )
    )
      throw new Error("Choose a .kdl Niri config or a .conf/.lua Hyprland config.");
    const edit = editCaptureConfig(
      root.text,
      format,
      target.appId,
      request.operation,
      request.shortcut,
    );
    const files = [root];
    const missing: string[] = [];
    if (target.desktop === "niri") {
      const visit = async (file: Snapshot, depth: number) => {
        if (
          depth > 10 ||
          files.length > MAX_FILES ||
          files.reduce((size, item) => size + item.bytes.length, 0) > MAX_BYTES
        )
          throw new Error("This config has too many included files. Use manual setup in Advanced.");
        for (const include of niriConfigIncludes(file.text)) {
          if (include.path.includes("$") || /[*?[\]]/.test(include.path))
            throw new Error("This config uses a dynamic include. Use manual setup in Advanced.");
          const path = include.path.startsWith("~/")
            ? NodePath.join(NodeOS.homedir(), include.path.slice(2))
            : NodePath.resolve(NodePath.dirname(file.path), include.path);
          let child: Snapshot;
          try {
            child = await readSnapshot(path);
          } catch (error) {
            if (include.optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
              missing.push(path);
              continue;
            }
            throw new Error(
              "Couldn't read an included Niri config. Check its location in Advanced.",
              { cause: error },
            );
          }
          if (files.some((item) => item.resolvedPath === child.resolvedPath)) continue;
          files.push(child);
          if (
            request.operation === "install" &&
            niriConfigConflict(child.text, target.appId, edit.shortcut)
          )
            throw new Error(
              `${edit.shortcut} is already used in ${child.path}. Choose another shortcut.`,
            );
          await visit(child, depth + 1);
        }
      };
      await visit(root, 0);
    } else if (request.operation === "install") {
      await this.checkHyprlandKeys(target.appId, edit.shortcut);
    }
    const preview = {
      id: NodeCrypto.randomUUID(),
      path: root.path,
      resolvedPath: root.resolvedPath,
      before: root.text,
      after: edit.after,
      shortcut: edit.shortcut,
      operation: request.operation,
    };
    this.pending = { preview, target, files, missing };
    return preview;
  }

  async apply(id: string, desktop: Target["desktop"]): Promise<DesktopCaptureConfigApplied> {
    const pending = this.pending;
    if (
      this.applying ||
      !pending ||
      pending.preview.id !== id ||
      pending.target.desktop !== desktop
    )
      throw new Error("This preview expired. Review changes again before saving.");
    this.pending = undefined;
    this.applying = true;
    const { preview, files } = pending;
    const root = files[0]!;
    const directory = NodePath.dirname(root.resolvedPath);
    const temporary = NodePath.join(directory, `.t3-capture-${NodeCrypto.randomUUID()}.tmp`);
    let staged = false;
    try {
      const unchanged = async () => {
        for (const path of pending.missing) {
          if (
            await NodeFSP.lstat(path).then(
              () => true,
              (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
            )
          )
            throw new Error(
              "Your config changed since this preview. Review changes again before saving.",
            );
        }
        for (const original of files) {
          const current = await readSnapshot(original.path).catch(() => undefined);
          if (
            !current ||
            current.resolvedPath !== original.resolvedPath ||
            current.stat.ino !== original.stat.ino ||
            current.stat.mode !== original.stat.mode ||
            !current.bytes.equals(original.bytes)
          )
            throw new Error(
              "Your config changed since this preview. Nothing was saved. Review changes again before saving.",
            );
        }
      };
      await unchanged();
      if (desktop === "hyprland" && preview.operation === "install")
        await this.checkHyprlandKeys(pending.target.appId, preview.shortcut);
      if (preview.before === preview.after) return { backupPath: null, warning: null };
      await NodeFSP.writeFile(temporary, preview.after, {
        flag: "wx",
        mode: root.stat.mode & 0o777,
      });
      staged = true;
      await NodeFSP.chmod(temporary, root.stat.mode & 0o777);
      if (desktop === "niri") {
        // Niri resolves includes against the selected path, not a dotfile symlink's target.
        const validationPath = NodePath.join(
          NodePath.dirname(root.path),
          NodePath.basename(temporary),
        );
        if (NodePath.resolve(validationPath) === NodePath.resolve(temporary)) {
          await this.tools.validateNiri(temporary);
        } else {
          await NodeFSP.symlink(temporary, validationPath);
          try {
            await this.tools.validateNiri(validationPath);
          } finally {
            await NodeFSP.unlink(validationPath);
          }
        }
      }
      await unchanged();
      const backupPath = `${root.resolvedPath}.t3-capture-backup-${NodeCrypto.randomUUID()}`;
      await NodeFSP.writeFile(backupPath, root.bytes, { flag: "wx", mode: 0o600 });
      await NodeFSP.rename(temporary, root.resolvedPath);
      staged = false;
      let warning: string | null = null;
      if (desktop === "hyprland") {
        try {
          await this.tools.reloadHyprland();
        } catch {
          warning =
            "Config saved, but Hyprland couldn't reload it cleanly. Check hyprctl configerrors, then run hyprctl reload.";
        }
      }
      return { backupPath, warning };
    } finally {
      if (staged) await NodeFSP.unlink(temporary).catch(() => undefined);
      this.applying = false;
    }
  }
}
