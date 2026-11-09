import { T3_LEARN_COMMAND, T3_LEARN_REPOSITORY } from "@t3tools/shared/t3LearnIdentity";

import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for another computer: install `ominax`, then run `command`. Both installers are shown
 * because the browser showing this is often not the computer being set up.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">macOS, Linux</p>
      <CommandBlock
        command={`curl -fsSL https://github.com/${T3_LEARN_REPOSITORY}/releases/latest/download/install.sh | sh`}
      />
      <p className="text-xs text-muted-foreground">Windows (PowerShell)</p>
      <CommandBlock
        command={`irm https://github.com/${T3_LEARN_REPOSITORY}/releases/latest/download/install.ps1 | iex`}
      />
      <p className="text-xs text-muted-foreground">Then</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        Skip the install if you already have <code className="font-mono">{T3_LEARN_COMMAND}</code>.
        If <code className="font-mono">{T3_LEARN_COMMAND}</code> is not found after installing, add
        the folder the installer names to your PATH.
      </p>
    </div>
  );
}
