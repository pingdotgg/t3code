import { translate } from "@t3tools/i18n";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { useMemo, useState } from "react";

import { primaryServerKeybindingsAtom } from "~/state/server";
import { useTheme } from "~/hooks/useTheme";
import { getLocalFileManagerName, isWindowsPlatform } from "~/lib/utils";
import { CommandPaletteContent } from "../CommandPaletteContent";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "../files/ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "../files/projectFilesQueryState";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "../ui/command";
import { toastManager } from "../ui/toast";

function emptyMessage(query: string, error: string | null, isPending: boolean): string {
  if (error) return error;
  if (isPending) {
    return query.trim()
      ? translate("common:uiSearchingProjectFiles", "Searching project files…")
      : translate("common:uiIndexingProjectFiles", "Indexing project files…");
  }
  return query.trim()
    ? translate("common:uiNoMatchingImageFiles", "No matching image files.")
    : translate("common:uiNoImageFilesFound", "No image files found.");
}
export function canPickExternalProjectFavicon(cwd: string, platform: string): boolean {
  return !isWindowsPlatform(platform) || isWindowsAbsolutePath(cwd);
}

export function ProjectFaviconPickerDialog(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPickExternal?: () => Promise<string | null>;
  readonly onSelect: (path: string) => void;
  readonly open: boolean;
  readonly projectName: string;
}) {
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [isPickingExternal, setIsPickingExternal] = useState(false);
  const result = useProjectFilePickerQuery(
    props.environmentId,
    props.cwd,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    { imageOnly: true },
  );
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const pickExternal = props.onPickExternal;
  const fileManagerName = getLocalFileManagerName(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const items = useMemo<CommandPaletteActionItem[]>(
    () =>
      getProjectFilePickerMatches(result.entries, result.matchedQuery).map((match) => ({
        kind: "action",
        value: `project-favicon:${match.path}`,
        searchTerms: [match.name, match.path],
        title: match.name,
        description: match.path,
        icon: <PierreEntryIcon pathValue={match.path} kind="file" theme={resolvedTheme} />,
        run: async () => props.onSelect(match.path),
      })),
    [props.onSelect, resolvedTheme, result.entries, result.matchedQuery],
  );

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <CommandDialogPopup
          aria-label={translate("common:uiChooseProjectIcon", "Choose project icon")}
          className="overflow-hidden"
          onBackdropPointerDown={() => props.onOpenChange(false)}
        >
          <CommandPaletteContent
            aria-label={translate("common:uiChooseProjectIcon", "Choose project icon")}
            autoHighlight="always"
            escapeLabel={translate("common:close", "Close")}
            footerActionLabel={translate("common:uiSelectIcon", "Select icon")}
            footerTrailing={
              pickExternal ? (
                <CommandFooterAction
                  disabled={isPickingExternal}
                  onClick={() => {
                    setIsPickingExternal(true);
                    void pickExternal()
                      .then((path) => {
                        if (!path) return;
                        props.onOpenChange(false);
                        props.onSelect(path);
                      })
                      .catch((error: unknown) => {
                        toastManager.add({
                          type: "error",
                          title: translate(
                            "common:uiCouldNotOpenImagePicker",
                            "Could not open image picker",
                          ),
                          description:
                            error instanceof Error
                              ? error.message
                              : translate("common:uiAnErrorOccurred", "An error occurred."),
                        });
                      })
                      .finally(() => setIsPickingExternal(false));
                  }}
                >
                  {translate("common:uiOpenIn", "Open in {{app}}", { app: fileManagerName })}
                </CommandFooterAction>
              ) : null
            }
            inputProps={{
              placeholder: translate("common:uiSearchImageFiles", "Search image files…"),
            }}
            mode="none"
            onItemHighlighted={(value) => {
              setHighlightedItemValue(typeof value === "string" ? value : null);
            }}
            onValueChange={(value) => {
              setHighlightedItemValue(null);
              setQuery(value);
            }}
            panelSize="tall-list"
            testId="project-favicon-picker"
            value={query}
          >
            <CommandPaletteResults
              groups={
                items.length > 0
                  ? [{ value: "project-favicon-files", label: props.projectName, items }]
                  : []
              }
              highlightedItemValue={highlightedItemValue}
              isActionsOnly={false}
              keybindings={keybindings}
              onExecuteItem={(item) => {
                if (item.kind !== "action") return;
                props.onOpenChange(false);
                void item.run();
              }}
              emptyStateMessage={emptyMessage(query, result.error, result.isPending)}
            />
          </CommandPaletteContent>
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
  );
}
