import type { MarkdownFrontmatterEntry } from "@t3tools/client-runtime/markdown-frontmatter";

function MarkdownFrontmatterList({ items }: { readonly items: ReadonlyArray<string> }) {
  const occurrences = new Map<string, number>();

  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => {
        const occurrence = occurrences.get(item) ?? 0;
        occurrences.set(item, occurrence + 1);

        return (
          <span
            key={`${item}:${occurrence}`}
            className="rounded-sm border border-border bg-muted/30 px-2.5 py-0.5"
          >
            {item}
          </span>
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
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm text-foreground/80">
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.key}>
              <th
                scope="row"
                className="w-px whitespace-nowrap border border-border bg-muted/30 px-4 py-2 text-right align-top font-semibold text-foreground"
              >
                {entry.key}
              </th>
              <td className="border border-border px-4 py-2 align-top">
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
    </div>
  );
}
