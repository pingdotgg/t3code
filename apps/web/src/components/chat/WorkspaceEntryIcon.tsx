import type { EnvironmentId } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

import { useFileMetadata } from "../../hooks/useFileMetadata";
import { PierreEntryIcon } from "./PierreEntryIcon";

/** Path chips share metadata queries across messages and the composer. A file
 * icon is neutral while the environment is offline or the path is unknown. */
export function WorkspaceEntryIcon(props: {
  path: string;
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
  theme: "light" | "dark";
}) {
  const metadata = useFileMetadata(props.environmentId, props.path, props.cwd);
  return (
    <PierreEntryIcon
      pathValue={props.path}
      kind={metadata?.kind === "directory" ? "directory" : "file"}
      mimeType={metadata?.mimeType}
      theme={props.theme}
    />
  );
}

export function WorkspaceEntryTooltip(props: {
  path: string;
  label?: string;
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
}) {
  const metadata = useFileMetadata(props.environmentId, props.path, props.cwd);
  return (
    <>
      {props.label ?? props.path}
      {metadata?.byteLength === undefined
        ? null
        : ` · ${formatAttachmentSize(metadata.byteLength)}`}
    </>
  );
}
