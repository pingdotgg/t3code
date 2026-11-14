import * as Option from "effect/Option";

import * as Electron from "electron";

import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";

export interface ContextMenuInstallerDeps {
  /** Copies a link URL to the clipboard. */
  readonly copyText: (text: string) => void;
  /** Copies the right-clicked image to the clipboard. */
  readonly copyImage: (contents: Electron.WebContents, params: Electron.ContextMenuParams) => void;
  /** Pops the native menu for the window. */
  readonly popupMenu: (input: ElectronMenu.ElectronMenuTemplateInput) => void;
}

/**
 * Builds the `context-menu` installer for a window and every guest it owns.
 * Kept imperative so callers can bridge their Effect runtimes in.
 */
export function createContextMenuInstaller(
  deps: ContextMenuInstallerDeps,
): (ownerWindow: Electron.BrowserWindow, contents: Electron.WebContents) => void {
  const contextMenuContents = new WeakSet<Electron.WebContents>();

  const installContextMenu = (
    ownerWindow: Electron.BrowserWindow,
    contents: Electron.WebContents,
  ): void => {
    if (contextMenuContents.has(contents)) return;
    contextMenuContents.add(contents);
    contents.on("context-menu", (event, params) => {
      event.preventDefault();
      if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
      // Right-clicking a guest may leave native editing roles targeting the host renderer.
      contents.focus();

      const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          menuTemplate.push({
            label: suggestion,
            click: () => {
              if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
            },
          });
        }
        if (params.dictionarySuggestions.length === 0) {
          menuTemplate.push({ label: "No suggestions", enabled: false });
        }
        menuTemplate.push({ type: "separator" });
      }

      if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
        menuTemplate.push(
          {
            label: "Copy Link",
            click: () => {
              deps.copyText(params.linkURL);
            },
          },
          { type: "separator" },
        );
      }

      if (params.mediaType === "image") {
        menuTemplate.push({
          label: "Copy Image",
          click: () => {
            deps.copyImage(contents, params);
          },
        });
        menuTemplate.push({ type: "separator" });
      }

      menuTemplate.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );

      deps.popupMenu({
        window: ownerWindow,
        template: menuTemplate,
        ...(params.frame ? { frame: params.frame } : {}),
      });
    });
    contents.on("did-create-window", (popup) => {
      installContextMenu(popup, popup.webContents);
    });
  };

  return installContextMenu;
}
