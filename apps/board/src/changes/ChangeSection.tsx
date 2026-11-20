import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import { changesPrefsAtom, previewInput } from "../state/changesView";
import { type DiffSource, filesViewAtom, openFile } from "../state/filesView";
import { ChangeRows } from "./ChangeRows";
import { changeSetOf } from "./changeSet";
import { useDiffPreview } from "./useDiffPreview";

/** One group of changed files in the Source Control tab: a header with its count and View all, and the files. */
export function ChangeSection({
  environmentId,
  cwd,
  title,
  source,
  revision,
  filter,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  title: string;
  source: DiffSource;
  revision: string;
  filter: string;
}) {
  const registry = useContext(RegistryContext);
  const { ignoreWhitespace, asTree } = useAtomValue(changesPrefsAtom);
  const { active } = useAtomValue(filesViewAtom);
  const [open, setOpen] = useState(true);
  const preview = useDiffPreview(
    environmentId,
    { ...previewInput(cwd, source, ignoreWhitespace), metadataOnly: true },
    revision,
  );
  const needle = filter.trim().toLowerCase();
  const loaded = preview.state === "ready" ? preview.source : null;
  const set = useMemo(
    () =>
      loaded === null
        ? null
        : changeSetOf(loaded, (path) => needle === "" || path.toLowerCase().includes(needle)),
    [loaded, needle],
  );
  const Chevron = open ? ChevronDown : ChevronRight;
  const openDiff = (path: string) => openFile(registry, { cwd, path, diff: source });
  const selected =
    active?.diff !== undefined &&
    active.cwd === cwd &&
    JSON.stringify(active.diff) === JSON.stringify(source)
      ? active.path
      : null;
  return (
    <section aria-label={title} data-testid="change-section" className="flex flex-col">
      <header className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 uppercase hover:text-fg"
        >
          <Chevron className="size-3.5" aria-hidden />
          {title}
          {set !== null && <span className="text-faint">{set.totals.files}</span>}
        </button>
        <span className="flex-1" />
        {set !== null && set.totals.files > 0 && (
          <button
            type="button"
            onClick={() => openDiff("")}
            className="rounded px-1.5 py-0.5 font-normal hover:bg-hover hover:text-fg"
          >
            View all
          </button>
        )}
      </header>
      {open &&
        (preview.state === "failed" ? (
          <p role="alert" className="px-3 py-2 text-[12px] text-red-300">
            {preview.message}
          </p>
        ) : set === null ? (
          <p className="px-3 py-2 text-[12px] text-faint">Loading changes</p>
        ) : set.totals.files === 0 ? (
          <p className="px-3 py-2 text-[12px] text-faint">
            {needle === "" ? "No changes" : "No file matches"}
          </p>
        ) : (
          <ChangeRows
            set={set}
            asTree={asTree}
            selectedPath={selected}
            onOpen={(file) => openDiff(file.path)}
          />
        ))}
    </section>
  );
}
