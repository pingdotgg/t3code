import type { ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ContextChipLabel } from "../ContextChip";
import { FileLinkPathPrefix } from "../../fork/FileLinkPathPrefix";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

export function FileTagChipContent(props: {
  icon?: ReactNode;
  path: string;
  label: string;
  labelPrefix?: string | undefined;
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
      <ContextChipLabel>
        <FileLinkPathPrefix prefix={props.labelPrefix} />
        {props.label}
      </ContextChipLabel>
    </>
  );
}
