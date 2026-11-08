import { markdownFrontmatterProperties } from "@t3tools/shared/markdownFrontmatterProperties";

export function MarkdownFrontmatterTable(props: { readonly markdown: string }) {
  const properties = markdownFrontmatterProperties(props.markdown);
  if (!properties) return null;

  return (
    <div className="chat-markdown mb-4 text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]">
      <table aria-label="Properties">
        <tbody>
          {properties.map((property) => (
            <tr key={property.key}>
              <th
                scope="row"
                className="w-0 border-b border-border/60 font-medium text-muted-foreground"
              >
                {/* On the span: `.chat-markdown th` sets text-wrap and outranks a class on the cell. */}
                <span className="whitespace-nowrap">{property.key}</span>
              </th>
              <td className="whitespace-pre-wrap">
                {property.structured ? <code>{property.value}</code> : property.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
