import { useArtifacts } from "../artifacts/ArtifactsContext";
import { ReadmeList } from "../artifacts/ReadmeList";
import { parseReadme } from "../domain/artifact";
import type { FileRef } from "../state/filesView";
import type { Artifact } from "../store/artifacts";
import { FilePreview } from "./FilePreview";
import { absolutePathOf, fileTarget } from "./target";

/** A ticket's README lists the files it proves, so it reads as that list. Any other file keeps the default body. */
const readmeBody = (artifact: Artifact) => (text: string) => {
  const entries = parseReadme(text);
  return entries.length > 0 ? <ReadmeList readme={artifact} entries={entries} /> : undefined;
};

/** The file of the active tab, in the main view where the board's canvas is. */
export function FilesView({ file }: { file: FileRef }) {
  const { files, all } = useArtifacts();
  const target = fileTarget(files, file);
  const readme = all.find(
    (artifact) =>
      artifact.name === "README.txt" && artifact.absolutePath === absolutePathOf(target),
  );
  return (
    <section aria-label="File preview" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <FilePreview
        key={`${target.cwd}/${target.path}`}
        target={target}
        {...(readme === undefined ? {} : { textBody: readmeBody(readme) })}
      />
    </section>
  );
}
