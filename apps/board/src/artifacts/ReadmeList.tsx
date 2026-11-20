import type { ReadmeEntry } from "../domain/artifact";
import { type Artifact, readmeTarget } from "../store/artifacts";
import { useArtifacts } from "./ArtifactsContext";

/** The files a ticket's README lists, each beside what it proves. A file that is listed opens in the viewer. */
export function ReadmeList({
  readme,
  entries,
}: {
  readme: Artifact;
  entries: ReadonlyArray<ReadmeEntry>;
}) {
  const { all, open } = useArtifacts();
  return (
    <ul data-testid="readme-list" className="divide-y divide-line">
      {entries.map((entry) => {
        const target = readmeTarget(readme, entry.file, all);
        return (
          <li key={entry.file} data-testid="readme-entry" className="px-4 py-2.5">
            {target === undefined ? (
              <span className="font-mono text-[12px] text-muted">{entry.file}</span>
            ) : (
              <button
                type="button"
                onClick={() => open(target)}
                className="font-mono text-[12px] text-focus underline underline-offset-2"
              >
                {entry.file}
              </button>
            )}
            <p data-testid="readme-proves" className="mt-0.5 text-[12px] break-words text-fg">
              {entry.proves === "" ? "Says nothing about it." : entry.proves}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
