import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import type { MessageResolver } from "~/i18n/messages";
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
  query: string,
  error: string | null,
  isPending: boolean,
  resolve: MessageResolver,
): string {
  if (error) return error;
  if (isPending)
    return query.trim()
      ? resolve(msg("Searching project files…"))
      : resolve(msg("Indexing project files…"));
  return query.trim()
    ? resolve(msg("No matching image files."))
    : resolve(msg("No image files found."));
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
  const gt = useGT();
  const m = useMessages();
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
    m,
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
          aria-label={gt("Choose project icon")}
          className="overflow-hidden"
          onBackdropPointerDown={() => props.onOpenChange(false)}
        >
          <CommandPaletteContent
            aria-label={gt("Choose project icon")}
            autoHighlight="always"
            escapeLabel={gt("Close")}
            footerActionLabel={gt("Select icon")}
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
                          title: gt("Could not open image picker"),
                          description:
                            error instanceof Error
                              ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
                              : gt("An error occurred."),
                        });
                      })
                      .finally(() => setIsPickingExternal(false));
                  }}
                >
                  {gt("Open in {fileManager}", { fileManager: fileManagerName })}
                </CommandFooterAction>
              ) : null
            }
            inputProps={{ placeholder: gt("Search image files…") }}
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
              emptyStateMessage={emptyMessage(query, result.error, result.isPending, m)}
            />
          </CommandPaletteContent>
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
  );
}
