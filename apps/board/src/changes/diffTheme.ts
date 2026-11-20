/** Classes that give Pierre's viewer the board's dark surface; the sheet below reads these. */
export const DIFF_SURFACE =
  "[--code-background:var(--color-bg)] [--code-foreground:var(--color-fg)] [--diff-addition:#2ea043] [--diff-deletion:#f85149] outline-none";

/**
 * The surface of T3's diff panel in the board's dark tokens: rows tint from the code surface, the
 * file header sticks and keeps one height, and the hunk separators read as quiet controls.
 */
export const DIFF_UNSAFE_CSS = `
[data-diffs-header], [data-diff], [data-file], [data-error-wrapper], [data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--code-background) 95%, var(--code-foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));
  --diffs-bg-addition-override: color-mix(in srgb, var(--code-background) 70%, var(--diff-addition));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--code-background) 60%, var(--diff-addition));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-addition));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--code-background) 70%, var(--diff-deletion));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--code-background) 60%, var(--diff-deletion));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-deletion));
  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}

[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: var(--code-background) !important;
  border-bottom-color: transparent !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  height: 32px !important;
  min-height: 32px !important;
  padding-block: 0 !important;
  padding-inline: 8px 12px !important;
}

[data-title] { cursor: pointer; font-family: var(--font-sans) !important; line-height: 16px !important; }
[data-title]:hover { text-decoration: underline; }

:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  height: 24px !important;
  margin-block: 0 !important;
  --diffs-bg-separator: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  color: color-mix(in srgb, var(--code-foreground) 50%, var(--code-background)) !important;
  font-family: var(--font-sans) !important;
  font-size: 11px !important;
}
`;
