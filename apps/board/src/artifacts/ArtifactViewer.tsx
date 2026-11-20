import { X } from "lucide-react";

import { KIND_LABEL } from "../domain/artifact";
import type { Artifact } from "../store/artifacts";
import { ArtifactBody } from "./ArtifactBody";

/** One artifact, read inside the app. Escape closes it while focus is in it. */
export function ArtifactViewer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  return (
    <section
      ref={(element) => element?.focus()}
      tabIndex={-1}
      aria-label="Artifact viewer"
      data-testid="artifact-viewer"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
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
          onClick={onClose}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </header>
      <ArtifactBody key={artifact.absolutePath} artifact={artifact} />
    </section>
  );
}
