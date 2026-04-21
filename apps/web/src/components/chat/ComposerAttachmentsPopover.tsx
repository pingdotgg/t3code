import { useCallback, useRef } from "react";
import { FolderIcon, FolderPlusIcon, ImageIcon, PlusIcon, XIcon } from "lucide-react";
import type { EnvironmentId, ThreadId, RuntimeMode } from "@marcode/contracts";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCreateHandle,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { readNativeApi } from "~/nativeApi";
import { newCommandId } from "~/lib/utils";
import { basenameOfPath } from "~/vscode-icons";
import { toastManager } from "~/components/ui/toast";
import { useCommandPaletteStore } from "~/commandPaletteStore";

interface ComposerAttachmentsPopoverProps {
  threadId: ThreadId;
  environmentId: EnvironmentId | null;
  projectCwd: string | null;
  additionalDirectories: readonly string[];
  onLocalDirectoriesChange?: ((directories: string[]) => void) | undefined;
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onAttachImages: (files: File[]) => void;
  disabled: boolean;
}

export function ComposerAttachmentsPopover({
  threadId,
  environmentId,
  projectCwd,
  additionalDirectories,
  onLocalDirectoriesChange,
  runtimeMode,
  onRuntimeModeChange,
  onAttachImages,
  disabled,
}: ComposerAttachmentsPopoverProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuHandleRef = useRef(MenuCreateHandle());
  const openAddFolder = useCommandPaletteStore((store) => store.openAddFolder);

  const count = additionalDirectories.length;

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) {
        onAttachImages(files);
      }
      e.target.value = "";
    },
    [onAttachImages],
  );

  const dispatchMetaUpdate = useCallback(
    async (nextDirs: string[]) => {
      if (onLocalDirectoriesChange) {
        onLocalDirectoriesChange(nextDirs);
        return;
      }
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        additionalDirectories: nextDirs,
      });
    },
    [threadId, onLocalDirectoriesChange],
  );

  // Initial path for the Add folder dialog: project cwd with "/../" so the
  // browser opens at the parent of the project directory (e.g. project
  // "/personal/marcode" → dialog opens at "/personal").
  const addFolderInitialPath = projectCwd ? `${projectCwd.replace(/\/+$/, "")}/../` : "~/";

  const handleOpenAddFolder = useCallback(() => {
    menuHandleRef.current.close();
    if (!environmentId) {
      toastManager.add({
        type: "error",
        title: "Unable to add folder",
        description: "No environment is available for this thread.",
      });
      return;
    }
    const currentDirectories = [...additionalDirectories];
    openAddFolder({
      environmentId,
      initialPath: addFolderInitialPath,
      onConfirm: async (absolutePath) => {
        if (currentDirectories.includes(absolutePath)) {
          return;
        }
        try {
          await dispatchMetaUpdate([...currentDirectories, absolutePath]);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to add folder",
            description:
              error instanceof Error
                ? error.message
                : "An unexpected error occurred while adding the folder.",
          });
        }
      },
    });
  }, [
    additionalDirectories,
    addFolderInitialPath,
    dispatchMetaUpdate,
    environmentId,
    openAddFolder,
  ]);

  const removeDirectory = useCallback(
    (path: string) => {
      void dispatchMetaUpdate(additionalDirectories.filter((d) => d !== path));
    },
    [additionalDirectories, dispatchMetaUpdate],
  );

  return (
    <>
      <Menu handle={menuHandleRef.current}>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="relative mr-1 shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80 sm:mr-1.5"
              disabled={disabled}
              aria-label="Attachments & settings"
            >
              <PlusIcon />
              {count > 0 && (
                <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-medium text-white">
                  {count}
                </span>
              )}
            </Button>
          }
        />
        <MenuPopup side="top" align="start" sideOffset={8} className="min-w-52">
          <MenuGroup>
            <MenuGroupLabel>Attach</MenuGroupLabel>
            <MenuItem onClick={() => fileInputRef.current?.click()}>
              <ImageIcon className="size-4" />
              Attach image
            </MenuItem>
            <MenuItem closeOnClick={false} onClick={handleOpenAddFolder}>
              <FolderPlusIcon className="size-4" />
              Add folder
            </MenuItem>
          </MenuGroup>

          {additionalDirectories.length > 0 && (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Folders</MenuGroupLabel>
                {additionalDirectories.map((dirPath) => (
                  <MenuItem
                    key={dirPath}
                    className="group"
                    onClick={() => removeDirectory(dirPath)}
                  >
                    <FolderIcon className="size-4" />
                    <span className="min-w-0 flex-1 truncate" title={dirPath}>
                      {basenameOfPath(dirPath) || dirPath}
                    </span>
                    <XIcon className="ml-auto size-3.5 opacity-50 group-data-highlighted:opacity-100" />
                  </MenuItem>
                ))}
              </MenuGroup>
            </>
          )}

          <MenuSeparator />

          <MenuGroup>
            <MenuGroupLabel>Access</MenuGroupLabel>
            <MenuRadioGroup
              value={runtimeMode}
              onValueChange={(value) => {
                if (!value || value === runtimeMode) return;
                onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
              <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
              <MenuRadioItem value="full-access">Full access</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
    </>
  );
}
