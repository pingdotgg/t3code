import type { ReactNode } from "react";

import { FileToolbar } from "./FileToolbar";
import { absolutePathOf, type FileTarget } from "./target";

/** A file kept as a path. Copy puts the path on the clipboard because there is no text to copy. */
export function PathOnly({ target, children }: { target: FileTarget; children: ReactNode }) {
  return (
    <>
      <FileToolbar
        target={target}
        copy={{ label: "Copy path", read: () => absolutePathOf(target) }}
        text={null}
      />
      {children}
    </>
  );
}
