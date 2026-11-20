import { useAtomValue } from "@effect/atom-react";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import type { ReactNode } from "react";

import { Notice } from "../artifacts/Notice";
import { CodeBody } from "../chat/CodeBody";
import { plainCode } from "../chat/HighlightedCode";
import { ChatMarkdown } from "../chat/Markdown";
import type { EditAccess } from "../domain/artifact";
import { artifactContentsAtom, artifactContentsKey } from "../state/artifacts";
import { BinaryPlaceholder } from "./BinaryPlaceholder";
import { DelimitedTable } from "./DelimitedTable";
import { FileToolbar } from "./FileToolbar";
import { PathOnly } from "./PathOnly";
import { type FileTarget, nameOf } from "./target";

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

/** Past this the colored code costs more to paint than it helps to read. */
const HIGHLIGHT_LIMIT = 200_000;

const MARKDOWN = /\.(?:md|mdx|markdown|mdown|mkd)$/i;

export function TextBody({
  target,
  access,
  onEdit,
  textBody,
}: {
  target: FileTarget;
  access: EditAccess;
  onEdit: (text: string) => void;
  textBody: ((text: string) => ReactNode | undefined) | undefined;
}) {
  const name = nameOf(target.path);
  const loaded = useAtomValue(
    artifactContentsAtom(artifactContentsKey(target.environmentId, target.cwd, target.path)),
  );
  if (loaded.status === "loading") return <Notice>Loading the file</Notice>;
  if (loaded.status === "failed") return <Notice tone="text-red-300">{loaded.message}</Notice>;
  const { contents } = loaded;
  if (contents.kind === "missing") return <Notice>This file is gone.</Notice>;
  if (contents.kind === "binary") {
    return (
      <PathOnly target={target} access={access}>
        <BinaryPlaceholder name={name} />
      </PathOnly>
    );
  }
  const text = contents.contents;
  const delimiter = filePreviewDelimiter({ name });
  const custom = textBody?.(text);
  return (
    <>
      <FileToolbar
        target={target}
        access={access}
        copy={{ label: "Copy file", read: () => text }}
        onEdit={
          contents.truncated
            ? null
            : () => {
                performance.mark("board:editor-open", { detail: { path: target.path } });
                onEdit(text);
              }
        }
        text={contents.truncated ? null : text}
      />
      {contents.truncated && (
        <p
          role="status"
          data-testid="truncated-notice"
          className="border-b border-amber-400/40 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-300"
        >
          Showing the first {formatBytes(encoder.encode(text).length)} of{" "}
          {formatBytes(contents.byteLength)}. Too large to edit.
        </p>
      )}
      {delimiter !== null && custom === undefined ? (
        <DelimitedTable text={text} delimiter={delimiter} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" data-wrap="true">
          {custom !== undefined ? (
            custom
          ) : MARKDOWN.test(name) ? (
            <div className="px-4 py-3 text-[13px]" data-testid="viewer-markdown">
              <ChatMarkdown text={text} />
            </div>
          ) : text.length > HIGHLIGHT_LIMIT ? (
            plainCode(text)
          ) : (
            <CodeBody code={text} language={getFiletypeFromFileName(name)} streaming={false} />
          )}
        </div>
      )}
    </>
  );
}
