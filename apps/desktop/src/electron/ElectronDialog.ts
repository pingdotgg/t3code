import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import { showDesktopConfirmDialog } from "../confirmDialog.ts";

export interface ElectronDialogPickFolderInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly defaultPath: Option.Option<string>;
}

export interface ElectronDialogConfirmInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly message: string;
}

export interface ElectronDialogShape {
  readonly pickFolder: (
    input: ElectronDialogPickFolderInput,
  ) => Effect.Effect<Option.Option<string>>;
  readonly confirm: (input: ElectronDialogConfirmInput) => Effect.Effect<boolean>;
  readonly showMessageBox: (
    options: Electron.MessageBoxOptions,
  ) => Effect.Effect<Electron.MessageBoxReturnValue>;
  readonly showErrorBox: (title: string, content: string) => Effect.Effect<void>;
}

export class ElectronDialog extends Context.Service<ElectronDialog, ElectronDialogShape>()(
  "t3/desktop/electron/Dialog",
) {}

const make = ElectronDialog.of({
  pickFolder: (input) =>
    Effect.gen(function* () {
      const openDialogOptions: Electron.OpenDialogOptions = Option.match(input.defaultPath, {
        onNone: () => ({
          properties: ["openDirectory", "createDirectory"],
        }),
        onSome: (defaultPath) => ({
          properties: ["openDirectory", "createDirectory"],
          defaultPath,
        }),
      });
      const result = yield* Option.match(input.owner, {
        onNone: () => Effect.promise(() => Electron.dialog.showOpenDialog(openDialogOptions)),
        onSome: (owner) =>
          Effect.promise(() => Electron.dialog.showOpenDialog(owner, openDialogOptions)),
      });

      if (result.canceled) {
        return Option.none();
      }
      return Option.fromNullishOr(result.filePaths[0]);
    }),
  confirm: (input) =>
    Effect.promise(() => showDesktopConfirmDialog(input.message, Option.getOrNull(input.owner))),
  showMessageBox: (options) => Effect.promise(() => Electron.dialog.showMessageBox(options)),
  showErrorBox: (title, content) =>
    Effect.sync(() => {
      Electron.dialog.showErrorBox(title, content);
    }),
});

export const layer = Layer.succeed(ElectronDialog, make);
