import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";

import {
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
} from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Separator } from "../ui/separator";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

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
  readonly shell: DesktopUpdateShell | undefined;
}) {
  return (
    <a
      className="mt-2 inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline decoration-dotted underline-offset-4 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      href={releaseUrl}
      onClick={(event) => {
        event.preventDefault();
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
    </a>
  );
}

export function SidebarUpdateReleaseNotes({
  shell,
  state,
  tooltip,
}: {
  readonly shell: DesktopUpdateShell | undefined;
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
}) {
  if (state.channel !== "nightly" || state.releaseNotes.length === 0) {
    return <>{tooltip}</>;
  }

  return (
    <div className="flex max-h-[calc(var(--available-height)-0.5rem)] min-h-0 w-fit max-w-[min(24rem,calc(100vw-2rem))] flex-col text-left">
      <div className="shrink-0 px-1">
        {state.status === "available" ? (
          <div>
            <div className="whitespace-nowrap text-sm leading-5 font-medium">
              Update ready to download
            </div>
            {state.availableVersion ? (
              <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
                {state.availableVersion}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-sm leading-5 font-medium">{tooltip}</div>
        )}
      </div>
      <div className="min-h-0 max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto px-1 pt-4 pb-1">
        {state.releaseNotes.map((releaseNote, index) => {
          const releaseUrl = getDesktopUpdateReleaseUrl(releaseNote.version);
          const omittedItemCount = Math.max(0, releaseNote.totalItems - releaseNote.items.length);
          const linkLabel =
            omittedItemCount === 0
              ? "View release on GitHub"
              : `${omittedItemCount} more ${omittedItemCount === 1 ? "change" : "changes"} on GitHub`;

          return (
            <div key={releaseNote.version}>
              {index > 0 && <Separator className="my-3 bg-border/60" />}
              <section>
                <h3 className="text-foreground text-xs leading-4 font-semibold">
                  {index === 0 ? "What's changed" : `Changes in ${releaseNote.version}`}
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
                    {linkLabel}
                  </ReleaseLink>
                ) : null}
              </section>
            </div>
          );
        })}
        {state.omittedReleaseCount > 0 ? (
          <div>
            <Separator className="my-3 bg-border/60" />
            <ReleaseLink releaseUrl={getDesktopUpdateReleaseHistoryUrl()} shell={shell}>
              {`${state.omittedReleaseCount} older ${state.omittedReleaseCount === 1 ? "release" : "releases"} on GitHub`}
            </ReleaseLink>
          </div>
        ) : null}
      </div>
    </div>
  );
}
