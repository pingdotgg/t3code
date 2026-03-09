import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

const MAX_SPELLING_SUGGESTIONS = 5;
const NO_SPELLING_SUGGESTIONS_LABEL = "No spelling suggestions";
const ADD_TO_DICTIONARY_LABEL = "Add to Dictionary";

type EditFlagName = keyof EditableContextMenuParams["editFlags"];
type EditActionDescriptor =
  | { readonly type: "separator" }
  | { readonly role: MenuItemConstructorOptions["role"]; readonly enabledFlag: EditFlagName };

const EDIT_MENU_ROLES = [
  { role: "undo", enabledFlag: "canUndo" },
  { role: "redo", enabledFlag: "canRedo" },
  { type: "separator" },
  { role: "cut", enabledFlag: "canCut" },
  { role: "copy", enabledFlag: "canCopy" },
  { role: "paste", enabledFlag: "canPaste" },
  { role: "delete", enabledFlag: "canDelete" },
  { type: "separator" },
  { role: "selectAll", enabledFlag: "canSelectAll" },
] satisfies readonly EditActionDescriptor[];

type EditableContextMenuParams = Pick<
  ContextMenuParams,
  "dictionarySuggestions" | "editFlags" | "isEditable" | "misspelledWord" | "x" | "y"
>;

type EditableContextMenuActions = {
  readonly replaceMisspelling: (value: string) => void;
  readonly addWordToDictionary: (value: string) => void;
};

function normalizeMisspelledWord(value: string): string {
  return value.trim();
}

function normalizeSpellingSuggestions(
  suggestions: readonly string[],
  misspelledWord: string,
): string[] {
  if (misspelledWord.length === 0) {
    return [];
  }

  const uniqueSuggestions = new Set<string>();
  for (const suggestion of suggestions) {
    const normalizedSuggestion = suggestion.trim();
    if (normalizedSuggestion.length === 0) {
      continue;
    }
    uniqueSuggestions.add(normalizedSuggestion);
    if (uniqueSuggestions.size >= MAX_SPELLING_SUGGESTIONS) {
      break;
    }
  }

  return [...uniqueSuggestions];
}

function buildEditActions(editFlags: EditableContextMenuParams["editFlags"]): MenuItemConstructorOptions[] {
  return EDIT_MENU_ROLES.map((item) => {
    if ("type" in item) {
      return { type: item.type };
    }
    return {
      role: item.role,
      enabled: editFlags[item.enabledFlag],
    };
  });
}

function buildSuggestionActions(
  misspelledWord: string,
  suggestions: readonly string[],
  actions: EditableContextMenuActions,
): MenuItemConstructorOptions[] {
  if (misspelledWord.length === 0) {
    return [];
  }

  const template =
    suggestions.length > 0
      ? suggestions.map<MenuItemConstructorOptions>((suggestion) => ({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        }))
      : [{ label: NO_SPELLING_SUGGESTIONS_LABEL, enabled: false }];

  template.push({
    label: ADD_TO_DICTIONARY_LABEL,
    click: () => actions.addWordToDictionary(misspelledWord),
  });
  template.push({ type: "separator" });
  return template;
}

function resolvePopupPosition(
  params: Pick<EditableContextMenuParams, "x" | "y">,
): { x?: number; y?: number } {
  const hasValidX = Number.isFinite(params.x) && params.x >= 0;
  const hasValidY = Number.isFinite(params.y) && params.y >= 0;
  const position: { x?: number; y?: number } = {};

  if (hasValidX) {
    position.x = Math.floor(params.x);
  }
  if (hasValidY) {
    position.y = Math.floor(params.y);
  }

  return position;
}

export function buildEditableContextMenuTemplate(
  params: EditableContextMenuParams,
  actions: EditableContextMenuActions,
): MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return [];
  }

  const misspelledWord = normalizeMisspelledWord(params.misspelledWord);
  const suggestions = normalizeSpellingSuggestions(params.dictionarySuggestions, misspelledWord);

  return [
    ...buildSuggestionActions(misspelledWord, suggestions, actions),
    ...buildEditActions(params.editFlags),
  ];
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
    ...resolvePopupPosition(params),
  });
  return true;
}
