import type { DesktopUpdateReleaseNote } from "@t3tools/contracts";

import { Separator } from "./ui/separator";

function keyReleaseNoteItems(items: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { item, key: JSON.stringify([item, occurrence]) };
  });
}

export function DesktopUpdateReleaseNotes({
  releaseNotes,
}: {
  readonly releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
}) {
  return releaseNotes.map((releaseNote, index) => (
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
      </section>
    </div>
  ));
}
