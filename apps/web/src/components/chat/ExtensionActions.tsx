import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { extensionEnvironment, extensionClientSurface } from "../../state/extensions";
import { openExtensionCommand } from "../ExtensionCommandHost";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";

export function ExtensionActions(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId?: ProjectId;
}) {
  const environment = useEnvironment(props.environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.extensions === true;
  const query = useEnvironmentQuery(
    supported
      ? extensionEnvironment.state({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const permission = useAtomValue(extensionEnvironment.invoke.permissionAtom(props.environmentId));
  const running = query.data?.filter((entry) => entry.status === "running") ?? [];
  const commands = running.flatMap((extension) =>
    (extension.manifest.commands ?? [])
      .filter(
        (command) => command.menu === "thread" || (command.menu === "project" && props.projectId),
      )
      .map((command) => ({ extension, command })),
  );
  const status = running.flatMap((extension) =>
    (extension.manifest.statusItems ?? []).flatMap((item) => {
      const command = extension.manifest.commands?.find((command) => command.id === item.command);
      return command ? [{ extension, command, text: item.text }] : [];
    }),
  );
  const open = (selection: (typeof commands)[number]) =>
    openExtensionCommand({
      ...selection,
      environmentId: props.environmentId,
      context: {
        threadId: props.threadId,
        ...(props.projectId ? { projectId: props.projectId } : {}),
        surface: extensionClientSurface,
      },
    });
  if (commands.length === 0 && status.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {status.map((item) => (
        <Button
          key={`${item.extension.manifest.id}:${item.command.id}`}
          size="xs"
          variant="ghost"
          disabled={!permission}
          onClick={() => open(item)}
        >
          {item.text}
        </Button>
      ))}
      {commands.length > 0 && (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="ghost" disabled={!permission} />}>
            Extensions
          </MenuTrigger>
          <MenuPopup align="end">
            {commands.map((item) => (
              <MenuItem
                key={`${item.extension.manifest.id}:${item.command.id}`}
                onClick={() => open(item)}
              >
                {item.command.title}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
