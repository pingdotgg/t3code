import { definePluginComponent } from "~/plugins/features";
import type { ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ContextChipLabel } from "../ContextChip";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

function PluginOriginalFileTagChipContent(props: {
  icon?: ReactNode;
  path: string;
  label: string;
  theme: "light" | "dark";
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
}) {
  return (
    <>
      {props.icon ?? (
        <WorkspaceEntryIcon
          path={props.path}
          environmentId={props.environmentId}
          cwd={props.cwd}
          theme={props.theme}
        />
      )}
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}

export const FileTagChipContent = definePluginComponent(
  "component:components/chat/FileTagChip/FileTagChipContent",
  PluginOriginalFileTagChipContent,
);
