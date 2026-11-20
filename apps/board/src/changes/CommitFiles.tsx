import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLink } from "lucide-react";
import { useContext, useMemo } from "react";

import { changesPrefsAtom, previewInput } from "../state/changesView";
import { filesViewAtom, openFile } from "../state/filesView";
import { ChangeRows } from "./ChangeRows";
import { changeSetOf } from "./changeSet";
import { useDiffPreview } from "./useDiffPreview";

/** A commit's changed files, which open as its diff, and the link that opens all of them together. */
export function CommitFiles({
  environmentId,
  cwd,
  sha,
  committedAt,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  sha: string;
  committedAt: string;
}) {
  const registry = useContext(RegistryContext);
  const { ignoreWhitespace } = useAtomValue(changesPrefsAtom);
  const { active } = useAtomValue(filesViewAtom);
  const diff = { kind: "commit", sha } as const;
  const preview = useDiffPreview(
    environmentId,
    { ...previewInput(cwd, diff, ignoreWhitespace), metadataOnly: true },
    "",
  );
  const loaded = preview.state === "ready" ? preview.source : null;
  const set = useMemo(() => (loaded === null ? null : changeSetOf(loaded)), [loaded]);
  const selected =
    active?.diff?.kind === "commit" && active.diff.sha === sha && active.cwd === cwd
      ? active.path
      : null;
  return (
    <div className="flex flex-col pb-1 pl-4 text-[12px]">
      <p className="px-2 py-0.5 text-[11px] text-faint">{new Date(committedAt).toLocaleString()}</p>
      {preview.state === "failed" ? (
        <p role="alert" className="px-2 text-red-300">
          {preview.message}
        </p>
      ) : set === null ? (
        <p className="px-2 text-faint">Loading files</p>
      ) : (
        <ChangeRows
          set={set}
          asTree={false}
          selectedPath={selected}
          onOpen={(file) => openFile(registry, { cwd, path: file.path, diff })}
        />
      )}
      <button
        type="button"
        onClick={() => openFile(registry, { cwd, path: "", diff })}
        className="mx-2 mt-0.5 flex w-fit items-center gap-1 rounded px-1 py-0.5 text-muted hover:bg-hover hover:text-fg"
      >
        <ExternalLink className="size-3" aria-hidden />
        Open all changes together
      </button>
    </div>
  );
}
