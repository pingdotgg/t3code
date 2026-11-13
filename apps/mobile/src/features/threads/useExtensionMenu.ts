import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { useEnvironments } from "../../state/environments";
import { extensionEnvironment } from "../../state/extensions";
import { useEnvironmentQuery } from "../../state/query";
import { useExtensionCommandPrompt } from "../extensions/useExtensionCommandPrompt";

export function useExtensionMenu(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId?: ProjectId,
): AppBarMenu | null {
  const environment = useEnvironments().environments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const query = useEnvironmentQuery(
    environment?.serverConfig?.environment.capabilities.extensions
      ? extensionEnvironment.state({ environmentId, input: {} })
      : null,
  );
  const allowed = useAtomValue(extensionEnvironment.invoke.permissionAtom(environmentId));
  const invoke = useExtensionCommandPrompt();
  const running = query.data?.filter((entry) => entry.status === "running") ?? [];
  const commands = running.flatMap((entry) =>
    (entry.manifest.commands ?? [])
      .filter((command) => command.menu === "thread" || (command.menu === "project" && projectId))
      .map((command) => ({ entry, command, title: command.title })),
  );
  const status = running.flatMap((entry) =>
    (entry.manifest.statusItems ?? []).flatMap((item) => {
      const command = entry.manifest.commands?.find((command) => command.id === item.command);
      return command ? [{ entry, command, title: item.text }] : [];
    }),
  );
  if (commands.length === 0 && status.length === 0) return null;
  const items = [...commands, ...status].map(({ entry, command, title }, index) => ({
    id: `${entry.manifest.id}:${command.id}:${index}`,
    title,
    subtitle: entry.manifest.name,
    disabled: !allowed,
    onPress: () =>
      invoke(environmentId, entry, command, { threadId, ...(projectId ? { projectId } : {}) }),
  }));
  return {
    title: "Extensions",
    icon: "wrench.and.screwdriver",
    status: status.map((item) => item.title).join(" · "),
    items,
  };
}
