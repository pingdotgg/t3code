import { FileText } from "lucide-react";

import type { Change, ChangeFile } from "./changeSet";
import { Counts } from "./Counts";

const LETTER = {
  modified: { letter: "M", tone: "text-amber-300", label: "Modified" },
  added: { letter: "A", tone: "text-emerald-300", label: "Added" },
  deleted: { letter: "D", tone: "text-red-300", label: "Deleted" },
  renamed: { letter: "R", tone: "text-sky-300", label: "Renamed" },
} as const satisfies Record<Change, { letter: string; tone: string; label: string }>;

export const ROW =
  "flex w-full min-w-0 items-center gap-1.5 rounded-sm py-[3px] pr-2 text-left text-[12px] hover:bg-hover";

export function FileRow({
  file,
  indent,
  flat,
  selected,
  onOpen,
}: {
  file: ChangeFile;
  indent: number;
  flat: boolean;
  selected: boolean;
  onOpen: (file: ChangeFile) => void;
}) {
  const { letter, tone, label } = LETTER[file.change];
  const dir = file.path.slice(0, Math.max(0, file.path.length - file.name.length - 1));
  return (
    <button
      type="button"
      data-testid="change-row"
      data-path={file.path}
      data-change={file.change}
      aria-label={`${file.path}, ${label.toLowerCase()}, ${file.additions} added, ${file.deletions} removed`}
      aria-current={selected}
      onClick={() => onOpen(file)}
      style={{ paddingLeft: 8 + indent * 12 }}
      className={`${ROW} ${selected ? "bg-hover" : ""}`}
    >
      <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 truncate text-fg">{file.name}</span>
      {flat && dir !== "" && <span className="min-w-0 shrink truncate text-faint">{dir}</span>}
      <span className="flex-1" />
      <Counts additions={file.additions} deletions={file.deletions} />
      <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${tone}`}>
        {letter}
      </span>
    </button>
  );
}
