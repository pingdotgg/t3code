import { DIFF_VIEW_UNSAFE_CSS } from "../../diffs/StyledDiffCodeView";

/** Guide files sit on the page canvas, while changed lines retain the normal diff highlights. */
export const GUIDE_DIFF_UNSAFE_CSS = `${DIFF_VIEW_UNSAFE_CSS}
[data-diffs-header], [data-diff], [data-file], [data-error-wrapper], [data-virtualizer-buffer] {
  --code-background: var(--background);
  --diffs-bg-context-override: var(--background);
  --diffs-bg-buffer-override: var(--background);
}
`;
