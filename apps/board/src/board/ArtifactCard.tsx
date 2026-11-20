import {
  ClipboardCheck,
  FileDiff,
  FileText,
  Image as ImageIcon,
  ListChecks,
  type LucideIcon,
  MessageSquareText,
  Palette,
  ScrollText,
  SearchCheck,
  Terminal,
} from "lucide-react";

import { useArtifacts } from "../artifacts/ArtifactsContext";
import { type ArtifactKind, isImagePath, KIND_LABEL } from "../domain/artifact";
import type { Artifact } from "../store/artifacts";
import { ArtifactThumb, THUMB } from "./ArtifactThumb";
import { ARTIFACT_HEIGHT } from "./layout";

const KIND_ICON = {
  screenshot: ImageIcon,
  proof: ClipboardCheck,
  script: Terminal,
  diff: FileDiff,
  report: ScrollText,
  brief: MessageSquareText,
  review: SearchCheck,
  plan: ListChecks,
  design: Palette,
  decisions: FileText,
} as const satisfies Record<ArtifactKind, LucideIcon>;

/** One artifact: a thumbnail or the kind's icon, its name, and its kind. Opening it shows the file in the viewer. */
export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const { open } = useArtifacts();
  const Icon = KIND_ICON[artifact.kind];
  return (
    <button
      type="button"
      data-testid="artifact-card"
      data-kind={artifact.kind}
      data-path={artifact.path}
      aria-label={`${KIND_LABEL[artifact.kind]} ${artifact.path}`}
      // A press that starts on a card is a click, not the start of a pan.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => open(artifact)}
      style={{ height: ARTIFACT_HEIGHT }}
      className="flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-bg px-1.5 text-left hover:bg-hover"
    >
      {isImagePath(artifact.path) ? (
        <ArtifactThumb artifact={artifact} />
      ) : (
        <span className={`grid ${THUMB} place-items-center bg-hover text-muted`}>
          <Icon className="size-3.5" aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{artifact.name}</span>
      <span className="rounded bg-hover px-1.5 text-[10px] leading-4 text-muted">
        {KIND_LABEL[artifact.kind]}
      </span>
    </button>
  );
}
