import { RegistryContext } from "@effect/atom-react";
import { type ReactNode, useContext, useState } from "react";

import { editAccess } from "../domain/artifact";
import { artifactContentsAtom, artifactContentsKey } from "../state/artifacts";
import { FileEditor } from "./FileEditor";
import { FilePreview } from "./FilePreview";
import type { FileTarget } from "./target";

/** One file, previewed, with an editor in its place while it is edited. Key it by the file so a new file starts previewed. */
export function FileSurface({
  target,
  onDirtyChange,
  textBody,
}: {
  target: FileTarget;
  onDirtyChange: (dirty: boolean) => void;
  textBody?: (text: string) => ReactNode | undefined;
}) {
  const registry = useContext(RegistryContext);
  const [editing, setEditing] = useState<{ readonly initial: string } | null>(null);
  if (editing === null) {
    return (
      <FilePreview
        target={target}
        access={editAccess(target.path)}
        onEdit={(initial) => setEditing({ initial })}
        {...(textBody === undefined ? {} : { textBody })}
      />
    );
  }
  return (
    <FileEditor
      target={target}
      initial={editing.initial}
      onDirtyChange={onDirtyChange}
      onClose={() => {
        // The preview reads through a cache, and the editor may have changed the file.
        registry.refresh(
          artifactContentsAtom(artifactContentsKey(target.environmentId, target.cwd, target.path)),
        );
        setEditing(null);
      }}
    />
  );
}
