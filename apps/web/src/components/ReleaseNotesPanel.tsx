import type { DesktopBridge, DesktopUpdateReleaseNote } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
import { Separator } from "./ui/separator";

type ReleaseNotesShell = Pick<DesktopBridge, "openExternal">;

function keyReleaseNoteItems(items: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { item, key: JSON.stringify([item, occurrence]) };
  });
}

function ReleaseLink({
  children,
  releaseUrl,
  shell,
}: {
  readonly children: string;
  readonly releaseUrl: string;
  readonly shell: ReleaseNotesShell | undefined;
}) {
  return (
    <a
      className="mt-2 inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline decoration-dotted underline-offset-4 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      href={releaseUrl}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        // Without a desktop shell the browser follows the link into a new tab.
        if (!shell) return;
        event.preventDefault();
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
    </a>
  );
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function ReleaseNoteGroup({
  isNewest,
  releaseNote,
  shell,
}: {
  readonly isNewest: boolean;
  readonly releaseNote: DesktopUpdateReleaseNote;
  readonly shell: ReleaseNotesShell | undefined;
}) {
  const releaseUrl = getDesktopUpdateReleaseUrl(releaseNote.version);
  const omittedItemCount = Math.max(0, releaseNote.totalItems - releaseNote.items.length);
  return (
    <section>
      <h3 className="text-foreground text-xs leading-4 font-semibold">
        {isNewest ? "What's changed" : `Changes in ${releaseNote.version}`}
      </h3>
      <ul className="mt-2 space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
        {keyReleaseNoteItems(releaseNote.items).map(({ item, key }) => (
          <li className="list-disc break-words" key={key}>
            {item}
          </li>
        ))}
      </ul>
      {releaseUrl ? (
        <ReleaseLink releaseUrl={releaseUrl} shell={shell}>
          {omittedItemCount === 0
            ? "View release on GitHub"
            : `${pluralize(omittedItemCount, "more change")} on GitHub`}
        </ReleaseLink>
      ) : null}
    </section>
  );
}

/** Release notes grouped by version under a caller-supplied header, as shown in update popovers. */
export function ReleaseNotesPanel({
  header,
  omittedReleaseCount,
  releaseNotes,
  shell,
}: {
  readonly header: ReactNode;
  readonly omittedReleaseCount: number;
  readonly releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
  readonly shell: ReleaseNotesShell | undefined;
}) {
  return (
    <div className="flex max-h-[calc(var(--available-height)-0.5rem)] min-h-0 w-fit max-w-[min(24rem,calc(100vw-2rem))] flex-col text-left">
      <div className="shrink-0 px-1">{header}</div>
      {releaseNotes.length > 0 ? (
        <div className="min-h-0 max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto px-1 pt-4 pb-1">
          {releaseNotes.map((releaseNote, index) => (
            <div key={releaseNote.version}>
              {index > 0 && <Separator className="my-3" />}
              <ReleaseNoteGroup isNewest={index === 0} releaseNote={releaseNote} shell={shell} />
            </div>
          ))}
          {omittedReleaseCount > 0 ? (
            <div>
              <Separator className="my-3" />
              <ReleaseLink releaseUrl={getDesktopUpdateReleaseHistoryUrl()} shell={shell}>
                {`${pluralize(omittedReleaseCount, "older release")} on GitHub`}
              </ReleaseLink>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
