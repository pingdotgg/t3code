import { useAtomValue } from "@effect/atom-react";
import { CircleHelp, Plus, Settings } from "lucide-react";
import { type ReactNode, useState } from "react";

import { updateNoticeAtom } from "../state/updatesAtoms";
import { Tooltip } from "../ui/Tooltip";
import { AddProject } from "./AddProject";
import { BrowserRow } from "./BrowserRow";
import { ForYouRow } from "./ForYouRow";
import { ForYouToasts } from "./ForYouToasts";
import { ProjectList } from "./ProjectList";
import { Section } from "./Section";

const footerIcon =
  "grid size-6 place-items-center rounded-md text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-60";

export function Sidebar({
  footer,
  onOpenSettings,
}: {
  footer?: ReactNode;
  onOpenSettings: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const updateOffered = useAtomValue(updateNoticeAtom);
  const settingsLabel = updateOffered ? "Settings, update available" : "Settings";
  return (
    <aside
      aria-label="Sidebar"
      className="flex min-h-0 flex-col gap-1 border-r border-line bg-sidebar px-2.5 py-3"
    >
      <div className="flex items-center gap-2 px-2 pb-3 font-bold tracking-tight">
        <div className="grid size-[22px] place-items-center rounded-md bg-fg text-xs text-bg">
          ab
        </div>
        Agent Board
      </div>
      <ForYouRow />
      <BrowserRow />
      <ForYouToasts />
      <Section
        title="Projects"
        className="min-h-0 shrink"
        actions={
          <Tooltip text="Add project" side="bottom">
            <button
              type="button"
              aria-label="Add project"
              aria-expanded={adding}
              onClick={() => setAdding((value) => !value)}
              className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <Plus className="size-4" />
            </button>
          </Tooltip>
        }
      >
        {adding && <AddProject onDone={() => setAdding(false)} />}
        <ProjectList />
      </Section>
      <div className="flex-1" />
      <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2 text-xs text-muted">
        <div className="flex items-center gap-1">
          <Tooltip text={settingsLabel}>
            <button
              type="button"
              aria-label={settingsLabel}
              onClick={onOpenSettings}
              className={`relative ${footerIcon}`}
            >
              <Settings className="size-4" />
              {updateOffered && (
                <span
                  data-testid="settings-update-dot"
                  className="absolute top-0.5 right-0.5 size-[7px] rounded-full bg-sky-400"
                />
              )}
            </button>
          </Tooltip>
          <Tooltip text="Help">
            <button type="button" disabled aria-label="Help" className={footerIcon}>
              <CircleHelp className="size-4" />
            </button>
          </Tooltip>
        </div>
        {footer}
      </div>
    </aside>
  );
}
