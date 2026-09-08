// @effect-diagnostics nodeBuiltinImport:off -- GNOME's per-user installation is a native adapter boundary.
// @effect-diagnostics globalTimers:off -- Bound calls into the user's desktop session.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Message, sessionBus, type MessageBus, type MessageLike } from "dbus-next";
import * as Schema from "effect/Schema";
import type { DesktopCaptureExtensionState } from "@t3tools/contracts";

import { GNOME_CAPTURE_FILES, GNOME_CAPTURE_UUID } from "./gnomeCaptureBundle.ts";
export { isGnomeCaptureSession } from "./linuxCaptureSession.ts";

const SHELL = "org.gnome.Shell";
const SHELL_PATH = "/org/gnome/Shell";
const EXTENSIONS = "org.gnome.Shell.Extensions";
const NumberValue = Schema.Struct({ value: Schema.Number });
const decodeInfo = Schema.decodeUnknownSync(
  Schema.Struct({
    state: Schema.optional(NumberValue),
    version: Schema.optional(NumberValue),
    error: Schema.optional(Schema.Struct({ value: Schema.String })),
  }),
);
const decodeProperties = Schema.decodeUnknownSync(
  Schema.Struct({
    ShellVersion: Schema.Struct({ value: Schema.String }),
    UserExtensionsEnabled: Schema.Struct({ value: Schema.Boolean }),
  }),
);
const Metadata = Schema.Struct({
  uuid: Schema.Literal(GNOME_CAPTURE_UUID),
  version: Schema.Number,
  "shell-version": Schema.Array(Schema.String),
});
const decodeMetadata = Schema.decodeUnknownSync(Schema.fromJsonString(Metadata));

type SetupPaths = { readonly bundle: string; readonly dataHome: string };

/** Copies only the shipped extension, offline. Replaced versions are kept for recovery. */
export async function installGnomeCaptureBundle({ bundle, dataHome }: SetupPaths) {
  const metadata = decodeMetadata(
    await NodeFSP.readFile(NodePath.join(bundle, "metadata.json"), "utf8"),
  );
  const parent = NodePath.join(dataHome, "gnome-shell", "extensions");
  const target = NodePath.join(parent, GNOME_CAPTURE_UUID);
  await NodeFSP.mkdir(parent, { recursive: true });
  const existing = await NodeFSP.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error(
      "The extension installation is not a regular directory. Manage it in GNOME Extensions instead.",
    );
  if (existing) {
    const installed = decodeMetadata(
      await NodeFSP.readFile(NodePath.join(target, "metadata.json"), "utf8"),
    );
    if (installed.version > metadata.version)
      throw new Error("A newer extension is installed. Update T3 Code instead of replacing it.");
  }
  const staged = await NodeFSP.mkdtemp(NodePath.join(parent, ".t3-capture-install-"));
  let backup: string | undefined;
  try {
    for (const name of GNOME_CAPTURE_FILES) {
      await NodeFSP.copyFile(NodePath.join(bundle, name), NodePath.join(staged, name));
      await NodeFSP.chmod(NodePath.join(staged, name), 0o644);
    }
    await NodeFSP.chmod(staged, 0o755);
    if (existing) {
      const backupParent = NodePath.join(dataHome, "t3code", "extension-backups");
      await NodeFSP.mkdir(backupParent, { recursive: true });
      backup = NodePath.join(
        await NodeFSP.mkdtemp(NodePath.join(backupParent, "capture-")),
        GNOME_CAPTURE_UUID,
      );
      await NodeFSP.rename(target, backup);
    }
    try {
      await NodeFSP.rename(staged, target);
    } catch (error) {
      if (backup) await NodeFSP.rename(backup, target);
      throw error;
    }
  } finally {
    await NodeFSP.rm(staged, { recursive: true, force: true });
  }
}

/** A short-lived, read-only probe unless the user explicitly invokes an action. */
export class GnomeCaptureSetup {
  private readonly disconnected: Promise<never>;
  private readonly paths: SetupPaths;
  private readonly bus: MessageBus;
  private failure: Error | undefined;
  constructor(paths: SetupPaths, bus: MessageBus = sessionBus()) {
    this.paths = paths;
    this.bus = bus;
    this.disconnected = new Promise((_, reject) =>
      bus.on("error", (error: Error) => {
        this.failure = error;
        reject(error);
      }),
    );
    void this.disconnected.catch(() => undefined);
  }

  close() {
    this.bus.disconnect();
  }

  private async call(message: Omit<MessageLike, "destination" | "path">) {
    if (this.failure) throw this.failure;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.bus.call(new Message({ destination: SHELL, path: SHELL_PATH, ...message })),
        this.disconnected,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "GNOME did not respond. Sign in to a GNOME Wayland session and try again.",
                ),
              ),
            5_000,
          );
        }),
      ]);
      if (!reply) throw new Error("GNOME returned no setup information.");
      return reply.body[0] as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  async state(): Promise<DesktopCaptureExtensionState> {
    try {
      const [properties, info, bundled, installed] = await Promise.all([
        this.call({
          interface: "org.freedesktop.DBus.Properties",
          member: "GetAll",
          signature: "s",
          body: [EXTENSIONS],
        }).then(decodeProperties),
        this.call({
          interface: EXTENSIONS,
          member: "GetExtensionInfo",
          signature: "s",
          body: [GNOME_CAPTURE_UUID],
        }).then(decodeInfo),
        NodeFSP.readFile(NodePath.join(this.paths.bundle, "metadata.json"), "utf8").then(
          decodeMetadata,
        ),
        NodeFSP.readFile(
          NodePath.join(
            this.paths.dataHome,
            "gnome-shell",
            "extensions",
            GNOME_CAPTURE_UUID,
            "metadata.json",
          ),
          "utf8",
        )
          .then(decodeMetadata)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          }),
      ]);
      const major = properties.ShellVersion.value.split(".")[0]!;
      if (!bundled["shell-version"].includes(major))
        return {
          status: "unsupported",
          message: `The bundled extension supports GNOME ${bundled["shell-version"].join(", ")}. This session runs GNOME ${major}.`,
        };
      if (!info.state && !installed)
        return {
          status: "not-installed",
          message:
            "Install the bundled extension to capture the active window without a picker. No download or administrator password is needed.",
        };
      if (installed && (!info.state || (info.version && installed.version > info.version.value)))
        return {
          status: "restart-required",
          message:
            "Installed. Save your work, sign out of GNOME and sign back in, then return here to enable the extension. Restarting T3 Code alone is not enough.",
        };
      if ((installed?.version ?? info.version?.value ?? 0) < bundled.version)
        return {
          status: "update-required",
          message:
            "A newer extension is bundled with this app. Install it, then sign out and back in to load the update.",
        };
      if (!properties.UserExtensionsEnabled.value)
        return {
          status: "extensions-disabled",
          message:
            "GNOME has disabled user extensions. Turn on Extensions in the GNOME Extensions app, then check again. T3 Code will not enable your other extensions for you.",
        };
      if (info.state?.value === 1)
        return {
          status: "enabled",
          message: "The T3 Code extension is running. Active-window snapshots are available.",
        };
      if (info.state?.value === 3 || info.state?.value === 4)
        return {
          status: "error",
          message:
            info.error?.value ||
            "GNOME could not load the extension. Check GNOME Extensions for details, or sign out and back in.",
        };
      return {
        status: "disabled",
        message:
          "Enable the T3 Code extension to allow active-window snapshots. You can disable it here at any time.",
      };
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Could not check GNOME extension setup.",
      };
    }
  }

  async perform(action: "install-extension" | "enable-extension" | "disable-extension") {
    const state = await this.state();
    if (action === "install-extension") {
      if (state.status !== "not-installed" && state.status !== "update-required")
        throw new Error(state.message);
      await installGnomeCaptureBundle(this.paths);
      // GNOME discovers a newly installed local extension at the next login.
      return;
    }
    if (action === "enable-extension" && state.status !== "disabled")
      throw new Error(state.message);
    const result = await this.call({
      interface: EXTENSIONS,
      member: action === "enable-extension" ? "EnableExtension" : "DisableExtension",
      signature: "s",
      body: [GNOME_CAPTURE_UUID],
    });
    if (result !== true)
      throw new Error("GNOME has not loaded the extension. Sign out and back in, then try again.");
  }
}
