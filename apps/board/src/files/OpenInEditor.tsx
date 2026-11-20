import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { useContext, useId, useState } from "react";

import { lastEditorAtom, openInEditor } from "../state/files";
import { serverEnvironment } from "../state/server";
import { Tooltip } from "../ui/Tooltip";
import { editorLabel, editorMenu } from "./editorChoice";
import { absolutePathOf, type FileTarget } from "./target";

/**
 * The three-dot menu of a file's header, shaped like Orca's: it lists the editors the server says
 * it can launch, the last one used first, and T3 launches the one picked. A refusal shows T3's
 * reason in the header. Without an editor to offer it draws nothing.
 */
export function OpenInEditor({ target }: { target: FileTarget }) {
  const registry = useContext(RegistryContext);
  const menuId = useId();
  const available = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const last = useAtomValue(lastEditorAtom);
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const editors = editorMenu(available?.availableEditors ?? [], last);
  if (editors.length === 0) return null;
  return (
    <>
      {refusal !== null && (
        <Tooltip text={refusal} side="bottom" align="end">
          <span role="alert" className="max-w-56 truncate text-[11px] text-red-300">
            {refusal}
          </span>
        </Tooltip>
      )}
      <div
        className="relative"
        onBlur={(event) => {
          if (
            open &&
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          ) {
            setOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Tooltip text="More actions" align="end">
          <button
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen(!open)}
            className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
        {open && (
          <div
            id={menuId}
            role="menu"
            aria-label="More actions"
            className="absolute top-full right-0 z-20 mt-1 flex w-max min-w-44 flex-col rounded-lg border border-line bg-panel p-1 shadow-panel"
          >
            {editors.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setRefusal(null);
                  void openInEditor(
                    registry,
                    target.environmentId,
                    id,
                    absolutePathOf(target),
                    target.cwd,
                  ).then(setRefusal);
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left whitespace-nowrap hover:bg-hover focus-visible:bg-hover"
              >
                <ExternalLink className="size-3.5 shrink-0 text-muted" aria-hidden />
                Open in {editorLabel(id)}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
