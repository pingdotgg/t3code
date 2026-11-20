import { X } from "lucide-react";
import { useCallback, useRef } from "react";

import { KIND_LABEL, parseReadme } from "../domain/artifact";
import { FileSurface } from "../files/FileSurface";
import { fileTarget, locate } from "../files/target";
import type { Artifact } from "../store/artifacts";
import { useArtifacts } from "./ArtifactsContext";
import { Notice } from "./Notice";
import { ReadmeList } from "./ReadmeList";

/** A ticket's README lists the files it proves, so it reads as that list. Any other file keeps the default body. */
const readmeBody = (artifact: Artifact) => (text: string) => {
  const entries = parseReadme(text);
  return entries.length > 0 ? <ReadmeList readme={artifact} entries={entries} /> : undefined;
};

/** One artifact, read inside the app, and edited when its kind allows. Escape closes it while focus is in it. */
export function ArtifactViewer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const { files } = useArtifacts();
  const located = locate(files.roots, artifact.absolutePath);
  const dirty = useRef(false);
  const setDirty = useCallback((next: boolean) => {
    dirty.current = next;
  }, []);
  const close = () => {
    if (!dirty.current || window.confirm("Discard your unsaved edits?")) {
      dirty.current = false;
      onClose();
    }
  };
  return (
    <section
      ref={(element) => element?.focus()}
      tabIndex={-1}
      aria-label="Artifact viewer"
      data-testid="artifact-viewer"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      className="absolute inset-3 z-30 flex flex-col overflow-hidden rounded-xl border border-line bg-sidebar shadow-panel outline-none"
    >
      <header className="flex items-start gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{artifact.name}</h3>
          <p className="truncate text-[11px] text-muted">
            {KIND_LABEL[artifact.kind]} · {artifact.ticketKey ?? "Board"} · {artifact.absolutePath}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close artifact viewer"
          onClick={close}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </header>
      {located === null ? (
        <Notice>This file is outside the project and its worktrees.</Notice>
      ) : (
        <FileSurface
          key={artifact.absolutePath}
          target={fileTarget(files, located.root, located.path)}
          onDirtyChange={setDirty}
          {...(artifact.name === "README.txt" ? { textBody: readmeBody(artifact) } : {})}
        />
      )}
    </section>
  );
}
