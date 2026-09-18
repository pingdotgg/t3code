/**
 * Syntax-highlighted blob rendering via `@pierre/diffs`' `<File>`.
 *
 * `React.lazy`-loaded from `Repo.tsx`'s BlobTab so the diffs+shiki
 * runtime stays out of the initial bundle. The filename drives language
 * detection (by extension); the built-in header is disabled — the tab
 * keeps its own lines/bytes bar.
 */
import type { FileContents } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import { useMemo } from "react";
import { useFileOptions } from "../diff.tsx";

const FileView = ({ name, text }: { name: string; text: string }) => {
  const file = useMemo<FileContents>(
    () => ({ name, contents: text }),
    [name, text],
  );
  const options = useFileOptions();
  return <File file={file} options={options} />;
};

export default FileView;
