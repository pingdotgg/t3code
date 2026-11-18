import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";
import type { ProjectScript } from "@t3tools/contracts";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScriptsCopy";
import type { ThreadGitMenuProps } from "./threadGitActions";
export { useThreadGitMenuDefinition } from "./threadGitActions";
export type { ThreadGitMenuProps } from "./threadGitActions";
export type ThreadGitControlsProps = ThreadGitMenuProps & {
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
};

export function threadTerminalMenu(
  props: ThreadGitControlsProps,
  resolve: MessageResolver = m,
): AppBarMenu | null {
  if (!props.canOpenTerminal) return null;
  return {
    title: resolve(msg("Terminal")),
    icon: "terminal",
    separateBackground: false,
    items: [
      ...(props.projectScripts.length > 0
        ? props.projectScripts.map((script) => ({
            id: `script-${script.id}`,
            title: projectScriptMenuLabel(script, resolve),
            icon: projectScriptMenuIcon(script.icon),
            subtitle: script.command,
            disabled: !props.canOperateTerminal,
            onPress: () => void props.onRunProjectScript(script),
          }))
        : [
            {
              id: "script-none",
              title: resolve(msg("No project scripts")),
              icon: "play",
              subtitle: resolve(msg("This project has no saved scripts yet")),
              disabled: true,
              onPress: () => {},
            },
          ]),
      ...props.terminalSessions.map((session) => ({
        id: `terminal-${session.terminalId}`,
        title: session.displayLabel,
        icon: "terminal",
        subtitle: [
          getTerminalStatusLabel(
            {
              status: session.status,
              hasRunningSubprocess: session.hasRunningSubprocess,
            },
            resolve,
          ),
          basename(session.cwd),
        ]
          .filter(Boolean)
          .join(" · "),
        onPress: () => props.onOpenTerminal(session.terminalId),
      })),
      {
        id: "terminal-new",
        title: resolve(msg("Open new terminal")),
        icon: "plus",
        subtitle: resolve(msg("Start another shell for this thread")),
        disabled: !props.canOperateTerminal,
        onPress: props.onOpenNewTerminal,
      },
    ],
  };
}
