import { useAtomValue } from "@effect/atom-react";
import { FileQuestion } from "lucide-react";

import { ChatMarkdown } from "../chat/Markdown";
import { isImagePath, parseReadme } from "../domain/artifact";
import { artifactContentsAtom, artifactContentsKey } from "../state/artifacts";
import type { Artifact } from "../store/artifacts";
import { ArtifactImage } from "./ArtifactImage";
import { useArtifacts } from "./ArtifactsContext";
import { Notice } from "./Notice";
import { ReadmeList } from "./ReadmeList";

const UNITS = ["B", "KB", "MB", "GB"] as const;

function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

const encoder = new TextEncoder();

/** An image, or the text the engine reads, shown as the file's kind needs. */
export function ArtifactBody({ artifact }: { artifact: Artifact }) {
  const { environmentId, cwd } = useArtifacts();
  const image = isImagePath(artifact.path);
  const loaded = useAtomValue(
    artifactContentsAtom(
      artifactContentsKey(environmentId, cwd, image ? "" : artifact.absolutePath),
    ),
  );
  if (image) return <ArtifactImage artifact={artifact} />;
  if (loaded.status === "loading") return <Notice>Loading the file</Notice>;
  if (loaded.status === "failed") return <Notice tone="text-red-300">{loaded.message}</Notice>;
  const { contents } = loaded;
  if (contents.kind === "missing") return <Notice>This file is gone.</Notice>;
  if (contents.kind === "binary") {
    return (
      <div
        data-testid="binary-placeholder"
        className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-muted"
      >
        <FileQuestion className="size-8" aria-hidden />
        <p className="text-fg">Binary file</p>
        <p className="text-[12px]">The viewer cannot show {artifact.name} as text.</p>
      </div>
    );
  }
  const readme = artifact.name === "README.txt" ? parseReadme(contents.contents) : [];
  return (
    <>
      {contents.truncated && (
        <p
          role="status"
          data-testid="truncated-notice"
          className="border-b border-amber-400/40 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-300"
        >
          Showing the first {formatBytes(encoder.encode(contents.contents).length)} of{" "}
          {formatBytes(contents.byteLength)}.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {readme.length > 0 ? (
          <ReadmeList readme={artifact} entries={readme} />
        ) : artifact.name.endsWith(".md") ? (
          <div className="px-4 py-3 text-[13px]" data-testid="viewer-markdown">
            <ChatMarkdown text={contents.contents} />
          </div>
        ) : (
          <pre className="px-4 py-3 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-fg">
            {contents.contents}
          </pre>
        )}
      </div>
    </>
  );
}
