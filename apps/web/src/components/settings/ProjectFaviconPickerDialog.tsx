import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { useState } from "react";

import { useT } from "../../hooks/useI18n";
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
import { ProjectFaviconThumbnail } from "./ProjectFaviconThumbnail";

function emptyMessage(
  t: ReturnType<typeof useT>,
  query: string,
  error: string | null,
  isPending: boolean,
): string {
  if (error) return error;
  if (isPending)
    return query.trim()
      ? t("settings.code.faviconPicker.searching")
      : t("settings.code.faviconPicker.indexing");
  return query.trim()
    ? t("settings.code.faviconPicker.noMatches")
    : t("settings.code.faviconPicker.noImages");
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
  const t = useT();
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
  const { onPickExternal: pickExternal, onSelect } = props;
  const fileManagerName = getLocalFileManagerName(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const items: CommandPaletteActionItem[] = getProjectFilePickerMatches(
    result.entries,
    result.matchedQuery,
  ).map((match) => ({
    kind: "action",
    value: `project-favicon:${match.path}`,
    searchTerms: [match.name, match.path],
    title: match.name,
    description: match.path,
    icon: (
      <ProjectFaviconThumbnail
        cwd={props.cwd}
        environmentId={props.environmentId}
        fallback={<PierreEntryIcon pathValue={match.path} kind="file" theme={resolvedTheme} />}
        path={match.path}
      />
    ),
    run: async () => onSelect(match.path),
  }));

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <CommandDialogPopup
          aria-label={t("settings.code.faviconPicker.title")}
          className="overflow-hidden"
          onBackdropPointerDown={() => props.onOpenChange(false)}
        >
          <CommandPaletteContent
            aria-label={t("settings.code.faviconPicker.title")}
            autoHighlight="always"
            escapeLabel={t("settings.code.faviconPicker.close")}
            footerActionLabel={t("settings.code.faviconPicker.selectIcon")}
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
                        onSelect(path);
                      })
                      .catch((error: unknown) => {
                        toastManager.add({
                          type: "error",
                          title: t("settings.code.faviconPicker.pickerFailed"),
                          description:
                            error instanceof Error
                              ? error.message
                              : t("settings.code.faviconPicker.genericError"),
                        });
                      })
                      .finally(() => setIsPickingExternal(false));
                  }}
                >
                  {t("settings.code.faviconPicker.openIn", { name: fileManagerName })}
                </CommandFooterAction>
              ) : null
            }
            inputProps={{ placeholder: t("settings.code.faviconPicker.searchPlaceholder") }}
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
              emptyStateMessage={emptyMessage(t, query, result.error, result.isPending)}
            />
          </CommandPaletteContent>
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
  );
}
