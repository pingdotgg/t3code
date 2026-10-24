import type { ScopedThreadRef, TerminalShellSetting } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { useTerminalShells } from "./useTerminalShells";

/**
 * Chevron beside "New terminal": lists the shells detected on the thread's
 * environment. The list is fetched when the menu first opens.
 */
export function NewTerminalShellMenu({
  threadRef,
  disabled,
  onSelect,
}: {
  threadRef: ScopedThreadRef;
  disabled: boolean;
  onSelect: (shell: TerminalShellSetting) => void;
}) {
  const { shells, status, load, canLoad } = useTerminalShells(threadRef.environmentId);

  return (
    <Menu onOpenChange={(open) => open && load()}>
      <MenuTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            disabled={disabled || !canLoad}
            aria-label="New terminal with shell"
          />
        }
      >
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end" width="content" className="max-w-80">
        {(shells ?? []).map((shell) => (
          <MenuItem key={shell.id} onClick={() => onSelect(shell.id)}>
            <ShellOption label={shell.label} command={shell.command} />
          </MenuItem>
        ))}
        {status === "error" ? (
          <MenuItem onClick={() => void load()} closeOnClick={false}>
            Could not load shells. Retry
          </MenuItem>
        ) : shells === null ? (
          <span className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</span>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function ShellOption({ label, command }: { label: string; command: string }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span>{label}</span>
      <span className="flex min-w-0 text-xs leading-4 text-muted-foreground">
        <MiddleTruncate value={command} />
      </span>
    </span>
  );
}
