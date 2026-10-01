import type { ClientUiKit, UiTreeRowProps } from "@t3tools/extension-sdk/ui";

export function FileTreeRow({
  kit,
  ...props
}: UiTreeRowProps & { readonly kit: ClientUiKit | null }) {
  if (kit) return <kit.TreeRow {...props} />;
  const { path, depth, directory, expanded, selected, style, label, ...attributes } = props;
  return (
    <button
      data-t3-files-fallback-control
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected === true}
      aria-expanded={directory ? expanded === true : undefined}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        textAlign: "left",
        font: "inherit",
        fontSize: 12,
        lineHeight: "16px",
        padding: "3px 6px",
        paddingLeft: 6 + depth * 14,
        border: "1px solid transparent",
        borderRadius: 5,
        cursor: "pointer",
        color: "var(--t3-files-text, var(--foreground, #20252d))",
        background: selected
          ? "var(--t3-files-accent-surface, var(--accent, #e8eef7))"
          : "transparent",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        ...style,
      }}
      {...attributes}
    >
      {directory ? (expanded ? "▾ " : "▸ ") : ""}
      {label ?? path.split("/").at(-1)}
      {directory ? "/" : ""}
    </button>
  );
}
