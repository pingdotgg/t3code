import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

const MAX_SPELLING_SUGGESTIONS = 5;

type EditableContextMenuParams = Pick<
  ContextMenuParams,
  "dictionarySuggestions" | "editFlags" | "isEditable" | "misspelledWord" | "x" | "y"
>;

type EditableContextMenuActions = {
  readonly replaceMisspelling: (value: string) => void;
  readonly addWordToDictionary: (value: string) => void;
};

function buildEditActions(
  editFlags: EditableContextMenuParams["editFlags"],
): MenuItemConstructorOptions[] {
  return [
    { role: "undo", enabled: editFlags.canUndo },
    { role: "redo", enabled: editFlags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: editFlags.canCut },
    { role: "copy", enabled: editFlags.canCopy },
    { role: "paste", enabled: editFlags.canPaste },
    { role: "delete", enabled: editFlags.canDelete },
    { type: "separator" },
    { role: "selectAll", enabled: editFlags.canSelectAll },
  ];
}

export function buildEditableContextMenuTemplate(
  params: EditableContextMenuParams,
  actions: EditableContextMenuActions,
): MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return [];
  }

  const template: MenuItemConstructorOptions[] = [];
  const misspelledWord = params.misspelledWord.trim();
  const suggestions =
    misspelledWord.length === 0
      ? []
      : params.dictionarySuggestions
          .map((suggestion) => suggestion.trim())
          .filter((suggestion) => suggestion.length > 0)
          .slice(0, MAX_SPELLING_SUGGESTIONS);

  if (misspelledWord.length > 0) {
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        });
      }
    } else {
      template.push({
        label: "No spelling suggestions",
        enabled: false,
      });
    }

    template.push({
      label: "Add to Dictionary",
      click: () => actions.addWordToDictionary(misspelledWord),
    });
    template.push({ type: "separator" });
  }

  template.push(...buildEditActions(params.editFlags));
  return template;
}

export function showEditableContextMenu(
  window: BrowserWindow,
  params: EditableContextMenuParams,
): boolean {
  const template = buildEditableContextMenuTemplate(params, {
    replaceMisspelling: (value) => {
      window.webContents.replaceMisspelling(value);
    },
    addWordToDictionary: (value) => {
      void window.webContents.session.addWordToSpellCheckerDictionary(value);
    },
  });

  if (template.length === 0) {
    return false;
  }

  Menu.buildFromTemplate(template).popup({
    window,
    x: Math.floor(params.x),
    y: Math.floor(params.y),
  });
  return true;
}
