import type { MarkdownFrontmatterEntry } from "@t3tools/client-runtime/markdown-frontmatter";

import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";

function MarkdownFrontmatterList({ items }: { readonly items: ReadonlyArray<string> }) {
  const occurrences = new Map<string, number>();

  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => {
        const occurrence = occurrences.get(item) ?? 0;
        occurrences.set(item, occurrence + 1);

        return (
          <Badge key={JSON.stringify([item, occurrence])} variant="outline">
            {item}
          </Badge>
        );
      })}
    </span>
  );
}

export function MarkdownFrontmatterTable({
  entries,
}: {
  readonly entries: ReadonlyArray<MarkdownFrontmatterEntry>;
}) {
  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="w-full max-w-full rounded-none"
    >
      <table className="markdown-table">
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.key}>
              <th
                scope="row"
                className="w-px whitespace-nowrap bg-muted/30 text-right align-middle font-semibold text-foreground"
              >
                {entry.key}
              </th>
              <td className="align-top text-foreground/80">
                {entry.value.kind === "text" ? (
                  <span className="whitespace-pre-wrap">{entry.value.text}</span>
                ) : entry.value.kind === "list" ? (
                  <MarkdownFrontmatterList items={entry.value.items} />
                ) : (
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
                    {entry.value.source}
                  </pre>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}
