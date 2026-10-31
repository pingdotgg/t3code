import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ThreadId,
  type ProjectScript,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";
import {
  ChevronDownIcon,
  DownloadIcon,
  FileDownIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  SquareIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { useEnvironment } from "../state/environments";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";

import { commandForProjectScript, primaryProjectScript } from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type { NewProjectScriptInput, ProjectScriptActionResult };

const NO_FILE_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

const MAC_MODIFIER_GLYPHS = new Set(["⌃", "⌥", "⇧", "⌘"]);

/**
 * One key cap per key (pen RozJm): "Ctrl+Shift+T" splits on "+", and a macOS
 * label like "⌘⇧T" splits its modifier glyphs off the key.
 */
function shortcutLabelKeys(label: string): string[] {
  if (label.length > 1 && label.includes("+")) {
    return label.split("+").filter((key) => key.length > 0);
  }
  const keys: string[] = [];
  let rest = label;
  while (rest.length > 1 && MAC_MODIFIER_GLYPHS.has(rest.charAt(0))) {
    keys.push(rest.charAt(0));
    rest = rest.slice(1);
  }
  return [...keys, rest];
}

interface ProjectScriptsControlProps {
  displayMode?: "toolbar" | "panel";
  presentation?: "toolbar" | "menu";
  onRequestMenuClose?: () => void;
  environmentId: EnvironmentId;
  threadId?: ThreadId;
  scripts: ReadonlyArray<ProjectScript>;
  fileScripts?: ReadonlyArray<T3ProjectFileScript>;
  preferredScriptId?: string | null;
  onRunScript?: ((script: ProjectScript) => void) | undefined;
  onAddScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export default function ProjectScriptsControl({
  displayMode = "toolbar",
  presentation = "toolbar",
  onRequestMenuClose,
  environmentId,
  threadId,
  scripts,
  fileScripts = NO_FILE_SCRIPTS,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const isPanel = displayMode === "panel";
  const servers = useThreadDiscoveredPorts({ environmentId, threadId: threadId ?? null });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "project action stop",
  });
  const canStopServer = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(environmentId),
  );
  const supportsStop =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.localServerStop === true;
  const [stoppingServer, setStoppingServer] = useState(false);
  // The project actions menu (pen RozJm): key caps that yield to an edit pencil, then add and
  // t3.json import entries. The touch menu presentation keeps its own rows.
  const isActionsMenu = presentation !== "menu" && !isPanel;
  const keybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const [actionsMenuOpen, setActionsMenuOpen] = useState({
    presentation,
    scripts: false,
    imports: false,
  });
  if (actionsMenuOpen.presentation !== presentation) {
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
  }
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);

  const primaryScript =
    (preferredScriptId ? scripts.find((script) => script.id === preferredScriptId) : undefined) ??
    primaryProjectScript(scripts);
  const runningScriptServer = (() => {
    if (!primaryScript?.previewUrl) return undefined;
    try {
      const url = new URL(primaryScript.previewUrl);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
      return servers.find(
        (server) => server.port === Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      );
    } catch {
      return undefined;
    }
  })();
  const importableScripts = fileScripts.filter(
    (fileScript) =>
      !scripts.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );

  const openAddDialog = () => {
    setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT });
  };

  const openEditDialog = (script: ProjectScript) => {
    onRequestMenuClose?.();
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
    setEditorRequest(editorRequestForScript(script, keybindings));
  };

  const submitScript = (scriptId: string | null, input: NewProjectScriptInput) =>
    scriptId === null ? onAddScript(input) : onUpdateScript(scriptId, input);

  const importFileScript = async (fileScript: T3ProjectFileScript) => {
    const payload: NewProjectScriptInput = {
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
      runOnSettle: fileScript.runOnSettle ?? false,
      ...(readEnvironmentScope(environmentId, AuthSettingsWriteScope) ? { keybinding: null } : {}),
      previewUrl: fileScript.previewUrl ?? null,
      autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
    };
    const result = await onAddScript(payload);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setEditorRequest({
        scriptId: null,
        initial: payload,
        error: error instanceof Error ? error.message : "Failed to import action.",
      });
    }
  };

  const importItems = importableScripts.map((fileScript) => (
    <MenuItem
      key={`${fileScript.name} ${fileScript.command}`}
      onClick={() => void importFileScript(fileScript)}
    >
      <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4" />
      <MenuItemLabel>{fileScript.name}</MenuItemLabel>
      <MenuShortcut>
        <DownloadIcon className="size-3.5" aria-label="Import" />
      </MenuShortcut>
    </MenuItem>
  ));
  // The actions menu folds the importable t3.json scripts into one entry.
  const headerImportMenuItem = importableScripts.length > 0 && (
    <MenuSub>
      <MenuSubTrigger>
        <FileDownIcon className="size-4" />
        <MenuItemLabel>From t3.json</MenuItemLabel>
      </MenuSubTrigger>
      <MenuSubPopup>{importItems}</MenuSubPopup>
    </MenuSub>
  );
  const importMenuItems = importableScripts.length > 0 && (
    <>
      {scripts.length > 0 && <MenuSeparator />}
      <MenuGroup>
        <MenuGroupLabel>From t3.json</MenuGroupLabel>
        {importableScripts.map((fileScript) => (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            key={`${fileScript.name} ${fileScript.command}`}
            onClick={() => void importFileScript(fileScript)}
          >
            <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4" />
            <MenuItemLabel>{fileScript.name}</MenuItemLabel>
            <MenuShortcut>
              <DownloadIcon className="size-3.5" aria-label="Import" />
            </MenuShortcut>
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );

  const scriptItems = (
    <>
      {scripts.map((script) => {
        const shortcutLabel = shortcutLabelForCommand(
          keybindings,
          commandForProjectScript(script.id),
        );
        if (isActionsMenu) {
          return (
            <MenuItem
              key={script.id}
              className="group"
              disabled={!onRunScript}
              onClick={() => onRunScript?.(script)}
            >
              <ScriptIcon icon={script.icon} className="size-4" />
              <MenuItemLabel>
                {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
              </MenuItemLabel>
              <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end ps-4">
                {shortcutLabel ? (
                  // The key caps yield their slot to the edit pencil on hover.
                  <span className="flex transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                    <KbdGroup>
                      {shortcutLabelKeys(shortcutLabel).map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  </span>
                ) : null}
                <span className="pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit ${script.name}`}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openEditDialog(script);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                </span>
              </span>
            </MenuItem>
          );
        }
        return (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            key={script.id}
            className="group"
            disabled={!onRunScript}
            onClick={() => onRunScript?.(script)}
          >
            <ScriptIcon icon={script.icon} className="size-4" />
            <MenuItemLabel>{projectScriptMenuLabel(script)}</MenuItemLabel>
            <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
              {shortcutLabel &&
                (presentation === "menu" ? (
                  <MenuShortcut className="ms-0 mr-7">{shortcutLabel}</MenuShortcut>
                ) : (
                  <span className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                    <MenuShortcut className="ms-0">{shortcutLabel}</MenuShortcut>
                  </span>
                ))}
              <span
                className={`absolute right-0 top-1/2 flex -translate-y-1/2 ${presentation === "menu" ? "" : "opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"}`}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-6"
                  aria-label={`Edit ${script.name}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openEditDialog(script);
                  }}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              </span>
            </span>
          </MenuItem>
        );
      })}
      {isActionsMenu ? (
        <>
          <MenuSeparator />
          <MenuItem onClick={openAddDialog}>
            <PlusIcon className="size-4" />
            <MenuItemLabel>Add project action…</MenuItemLabel>
          </MenuItem>
          {headerImportMenuItem}
        </>
      ) : (
        <>
          {importMenuItems}
          <MenuItem density={presentation === "menu" ? "touch" : "default"} onClick={openAddDialog}>
            <PlusIcon className="size-4" />
            <MenuItemLabel>{isPanel ? "Add project action…" : "Add action"}</MenuItemLabel>
          </MenuItem>
        </>
      )}
    </>
  );

  return (
    <>
      {presentation === "menu" ? (
        <>
          {primaryScript && (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={!onRunScript}
              onClick={() => onRunScript?.(primaryScript)}
            >
              <ScriptIcon icon={primaryScript.icon} className="size-4" />
              <MenuItemLabel>Run {primaryScript.name}</MenuItemLabel>
              <MenuShortcut>
                {shortcutLabelForCommand(keybindings, commandForProjectScript(primaryScript.id))}
              </MenuShortcut>
            </MenuItem>
          )}
          {scripts.length > 0 || importableScripts.length > 0 ? (
            <MenuSub
              open={actionsMenuOpen.scripts}
              onOpenChange={(open) =>
                setActionsMenuOpen({ presentation, scripts: open, imports: false })
              }
            >
              <MenuSubTrigger density="touch">
                <ScriptIcon icon="play" className="size-4" />
                <MenuItemLabel>Project actions</MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>{scriptItems}</MenuSubPopup>
            </MenuSub>
          ) : (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              onClick={openAddDialog}
            >
              <PlusIcon className="size-4" />
              <MenuItemLabel>Add project action…</MenuItemLabel>
            </MenuItem>
          )}
        </>
      ) : isPanel ? (
        <div className="flex items-center" role="group" aria-label="Project scripts">
          {primaryScript ? (
            <ThreadDetailsControl
              aria-label={`Run ${primaryScript.name}`}
              disabled={!onRunScript}
              onClick={() => onRunScript?.(primaryScript)}
            >
              <span className="relative shrink-0">
                <SquareTerminalIcon className="size-4 text-muted-foreground" />
                {runningScriptServer ? (
                  <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-success" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{primaryScript.name}</span>
            </ThreadDetailsControl>
          ) : (
            <ThreadDetailsControl onClick={openAddDialog}>
              <SquareTerminalIcon />
              <MenuItemLabel>Add project action…</MenuItemLabel>
            </ThreadDetailsControl>
          )}
          {supportsStop && runningScriptServer?.pid != null ? (
            <ThreadDetailsControl
              part="icon"
              aria-label={`Stop ${primaryScript?.name}`}
              disabled={!canStopServer || stoppingServer}
              onClick={async () => {
                setStoppingServer(true);
                await stopServer({
                  environmentId,
                  input: { pid: runningScriptServer.pid!, port: runningScriptServer.port },
                });
                setStoppingServer(false);
              }}
            >
              <SquareIcon />
            </ThreadDetailsControl>
          ) : null}
          <Menu
            open={actionsMenuOpen.scripts}
            onOpenChange={(open) =>
              setActionsMenuOpen({ presentation, scripts: open, imports: false })
            }
          >
            <MenuTrigger render={<ThreadDetailsControl part="icon" aria-label="Project actions" />}>
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup side="bottom" align="end">
              {scriptItems}
            </MenuPopup>
          </Menu>
        </div>
      ) : primaryScript ? (
        <Group role="group" aria-label="Project scripts">
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="sm"
                  variant="secondary"
                  panel={false}
                  className="w-8 sm:w-7 @4xl/header-actions:w-auto!"
                  aria-label={`Run ${primaryScript.name}`}
                  // Tooltip replaces the button data-slot, so toolbar theming needs a separate hook.
                  data-toolbar-control=""
                  aria-disabled={!onRunScript || undefined}
                  onClick={() => onRunScript?.(primaryScript)}
                />
              }
            >
              <ScriptIcon icon={primaryScript.icon} />
              <span className="sr-only @4xl/header-actions:not-sr-only @4xl/header-actions:ml-0.5">
                {primaryScript.name}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              {onRunScript
                ? `Run ${primaryScript.name}`
                : "Pair this client again with permission to run terminal commands."}
            </TooltipPopup>
          </Tooltip>
          <GroupSeparator className="hidden @4xl/header-actions:block" />
          <Menu
            open={actionsMenuOpen.scripts}
            onOpenChange={(open) =>
              setActionsMenuOpen({ presentation, scripts: open, imports: false })
            }
          >
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size="icon-sm"
                  variant="secondary"
                  panel={false}
                  aria-label="Script actions"
                />
              }
            >
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-64">
              <MenuGroup>
                <MenuGroupLabel>Project actions</MenuGroupLabel>
                {scriptItems}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </Group>
      ) : scripts.length > 0 || importableScripts.length > 0 ? (
        <Menu
          highlightItemOnHover={false}
          open={actionsMenuOpen.imports}
          onOpenChange={(open) =>
            setActionsMenuOpen({ presentation, scripts: false, imports: open })
          }
        >
          <MenuTrigger
            render={<Button size="sm" variant="secondary" aria-label="Project actions" />}
          >
            <WrenchIcon className="size-3.5" />
            <span className="sr-only @4xl/header-actions:not-sr-only @4xl/header-actions:ml-0.5">
              Actions
            </span>
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">{scriptItems}</MenuPopup>
        </Menu>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="sm"
                variant="secondary"
                panel={false}
                className="w-8 sm:w-7 @4xl/header-actions:w-auto!"
                aria-label="Add action"
                data-toolbar-control=""
                onClick={openAddDialog}
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span className="sr-only @4xl/header-actions:not-sr-only @4xl/header-actions:ml-0.5">
              Add action
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">Add action</TooltipPopup>
        </Tooltip>
      )}

      <ProjectScriptEditorDialog
        environmentId={environmentId}
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={(scriptId) => void onDeleteScript(scriptId)}
        onClose={() => setEditorRequest(null)}
      />
    </>
  );
}
