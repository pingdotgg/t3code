import { Paperclip } from "lucide-react";

import { useArtifacts } from "../artifacts/ArtifactsContext";

/** The artifact count of a ticket or the board. Pressing it opens or closes its cards. */
export function ArtifactCount({ id, count }: { id: string; count: number }) {
  const { expanded, toggle } = useArtifacts();
  const open = expanded.has(id) && count > 0;
  return (
    <button
      type="button"
      data-testid="artifact-count"
      aria-label={`${count} ${count === 1 ? "artifact" : "artifacts"}`}
      aria-expanded={open}
      disabled={count === 0}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => toggle(id)}
      className={`inline-flex items-center gap-1 rounded border px-1.5 text-[11px] leading-[18px] ${open ? "border-focus text-fg" : "border-line text-muted"} ${count === 0 ? "opacity-60" : "hover:bg-hover hover:text-fg"}`}
    >
      <Paperclip className="size-3" aria-hidden />
      {count}
    </button>
  );
}
