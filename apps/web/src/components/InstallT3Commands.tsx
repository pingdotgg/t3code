import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

import { translateDynamic } from "../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`ui:${key}`, options);

/**
 * Setup steps for another computer: install `t3`, then run `command`. Both installers are shown
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
      <p className="text-xs text-muted-foreground">{td("macosLinux")}</p>
      <CommandBlock command="curl -fsSL https://t3.codes/install.sh | sh" />
      <p className="text-xs text-muted-foreground">{td("windowsPowerShell")}</p>
      <CommandBlock command="irm https://t3.codes/install.ps1 | iex" />
      <p className="text-xs text-muted-foreground">{td("thenRun")}</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        {td("skipInstallAlreadyHave")} <code className="font-mono">t3</code>
        {td("skipInstallIfSeparator")} <code className="font-mono">t3</code>{" "}
        {td("pathInstructionSuffix")}
      </p>
    </div>
  );
}
