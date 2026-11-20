import type { ReactNode } from "react";

import type { EditAccess } from "../domain/artifact";
import { FileToolbar } from "./FileToolbar";
import { absolutePathOf, type FileTarget } from "./target";

/** A file kept as a path. Copy puts the path on the clipboard because there is no text to copy. */
export function PathOnly({
  target,
  access,
  children,
}: {
  target: FileTarget;
  access: EditAccess;
  children: ReactNode;
}) {
  return (
    <>
      <FileToolbar
        target={target}
        access={access}
        copy={{ label: "Copy path", read: () => absolutePathOf(target) }}
        onEdit={null}
        text={null}
      />
      {children}
    </>
  );
}
