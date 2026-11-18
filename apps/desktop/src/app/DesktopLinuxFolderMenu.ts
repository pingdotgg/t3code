import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  escapeDesktopEntryExecArgument,
  escapeDesktopEntryString,
  resolveLinuxExecTarget,
} from "./DesktopLinuxUrlHandler.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logWarning } = makeComponentLogger("desktop-linux-folder-menu");

// One token: Electron does not guarantee second-instance argv order, so a separate value could detach.
const OPEN_FOLDER_ARGUMENT_PREFIX = "--open-folder=";

export function readOpenFolderArgument(argv: ReadonlyArray<string>): string | null {
  for (const value of argv) {
    if (!value.startsWith(OPEN_FOLDER_ARGUMENT_PREFIX)) continue;
    const folder = value.slice(OPEN_FOLDER_ARGUMENT_PREFIX.length);
    return folder.startsWith("/") ? folder : null;
  }
  return null;
}

export function renderKdeServiceMenu(input: {
  readonly menuName: string;
  readonly execTarget: string;
  readonly iconPath: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Service",
    "MimeType=inode/directory;",
    "X-KDE-Protocols=file",
    "Actions=openFolder",
    "X-KDE-ServiceTypes=KonqPopupMenu/Plugin",
    "",
    "[Desktop Action openFolder]",
    `Name=${escapeDesktopEntryString(input.menuName)}`,
    `Icon=${escapeDesktopEntryString(input.iconPath)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)} ${OPEN_FOLDER_ARGUMENT_PREFIX}%f`,
    "",
  ].join("\n");
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export function renderNautilusScript(input: { readonly execTarget: string }): string {
  return [
    "#!/bin/sh",
    // Nautilus passes the selection as arguments and runs in the current folder.
    "folder=${1:-.}",
    '[ -d "$folder" ] || folder=.',
    'folder=$(cd -- "$folder" && pwd) || exit 1',
    `exec ${shellQuote(input.execTarget)} "${OPEN_FOLDER_ARGUMENT_PREFIX}$folder"`,
    "",
  ].join("\n");
}

export class DesktopLinuxFolderMenu extends Context.Service<
  DesktopLinuxFolderMenu,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLinuxFolderMenu") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const { path } = environment;

  const installExecutable = Effect.fn("DesktopLinuxFolderMenu.installExecutable")(
    function* (filePath: string, content: string) {
      const existing = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.orElseSucceed(() => null));
      if (existing !== content) {
        yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fileSystem.writeFileString(filePath, content);
      }
      // KIO refuses to run a service menu in the home directory unless it is executable.
      yield* fileSystem.chmod(filePath, 0o755);
    },
    (effect, filePath) =>
      effect.pipe(
        Effect.catch((error) =>
          logWarning("folder menu install failed", { filePath, category: error.reason._tag }),
        ),
      ),
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux" || !environment.isPackaged) return;
    const execTarget = resolveLinuxExecTarget(environment);
    const dataDir = path.join(environment.linuxApplicationsDir, "..");
    const appId = environment.linuxDesktopEntryName.replace(/\.desktop$/u, "");
    const menuName = `Open in ${environment.displayName}`;
    yield* installExecutable(
      path.join(dataDir, "kio", "servicemenus", `${appId}.OpenFolder.desktop`),
      renderKdeServiceMenu({
        menuName,
        execTarget,
        iconPath: path.join(dataDir, "icons", `${environment.linuxDesktopEntryName}.png`),
      }),
    );
    yield* installExecutable(
      path.join(dataDir, "nautilus", "scripts", menuName),
      renderNautilusScript({ execTarget }),
    );
  }).pipe(Effect.withSpan("desktop.linuxFolderMenu.register"));

  return DesktopLinuxFolderMenu.of({ register });
});

export const layer = Layer.effect(DesktopLinuxFolderMenu, make);
