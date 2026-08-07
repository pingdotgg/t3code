import {
  isTerminalId,
  TERMINAL_IDS,
  terminalLabel,
  type EditorId,
  type EnvironmentId,
  type TerminalId,
} from "@t3tools/contracts";
import { ChevronDownIcon, TerminalIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { usePreferredTerminal } from "../../editorPreferences";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

/** Installed terminals, in the order the menu lists them. */
export const resolveTerminalOptions = (
  availableEditors: ReadonlyArray<EditorId>,
): ReadonlyArray<TerminalId> => {
  const available = new Set(availableEditors.filter(isTerminalId));
  return TERMINAL_IDS.filter((id) => available.has(id));
};

/**
 * Opens a shell in the project. Deliberately its own control rather than a row
 * in the Open-in picker: a terminal is not an app you open the project *in*,
 * and picking one should not move the editor the Open button uses.
 */
export const OpenTerminalPicker = memo(function OpenTerminalPicker({
  environmentId,
  availableEditors,
  openInCwd,
  compact = false,
}: {
  environmentId: EnvironmentId;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  compact?: boolean;
}) {
  const openTerminalMutation = useAtomCommand(shellEnvironment.openInEditor, "open terminal");
  const terminals = useMemo(() => resolveTerminalOptions(availableEditors), [availableEditors]);
  const [preferredTerminal, setPreferredTerminal] = usePreferredTerminal(terminals);

  const openTerminal = useCallback(
    (terminalId: TerminalId | null) => {
      if (!openInCwd) return;
      const terminal = terminalId ?? preferredTerminal;
      if (!terminal) return;
      const result = openTerminalMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor: terminal,
        },
      });
      setPreferredTerminal(terminal);
      return result;
    },
    [environmentId, openInCwd, openTerminalMutation, preferredTerminal, setPreferredTerminal],
  );

  if (terminals.length === 0) return null;

  return (
    <Group aria-label="Open terminal">
      <Button
        aria-label={
          preferredTerminal
            ? `Open project in ${terminalLabel(preferredTerminal)}`
            : "Open project terminal"
        }
        className="ps-[8.5px]"
        size="xs"
        variant="outline"
        disabled={!preferredTerminal || !openInCwd}
        onClick={() => openTerminal(preferredTerminal)}
      >
        <TerminalIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span
          className={
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
          }
        >
          Terminal
        </span>
      </Button>
      {terminals.length > 1 && (
        <>
          <GroupSeparator
            {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})}
          />
          <Menu>
            <MenuTrigger
              render={<Button aria-label="Choose terminal" size="icon-xs" variant="outline" />}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {terminals.map((terminal) => (
                <MenuItem key={terminal} onClick={() => openTerminal(terminal)}>
                  <TerminalIcon aria-hidden="true" className="text-muted-foreground" />
                  {terminalLabel(terminal)}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </>
      )}
    </Group>
  );
});
