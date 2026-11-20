import type { Artifact } from "../store/artifacts";
import { ArtifactCard } from "./ArtifactCard";
import { ARTIFACT_GAP, ARTIFACT_HEIGHT } from "./layout";

const COLUMN_WIDTH = 240;

/** The cards of a ticket's or the board's artifacts, in one column, or in columns of `rows` cards. */
export function ArtifactCards({
  artifacts,
  rows,
}: {
  artifacts: ReadonlyArray<Artifact>;
  rows?: number;
}) {
  return (
    <div
      data-testid="artifact-cards"
      className={rows === undefined ? "flex flex-col" : "grid grid-flow-col"}
      style={{
        gap: ARTIFACT_GAP,
        ...(rows === undefined
          ? {}
          : {
              gridTemplateRows: `repeat(${rows}, ${ARTIFACT_HEIGHT}px)`,
              gridAutoColumns: COLUMN_WIDTH,
            }),
      }}
    >
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.absolutePath} artifact={artifact} />
      ))}
    </div>
  );
}
