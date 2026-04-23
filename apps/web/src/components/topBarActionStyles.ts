const EXPANDED_TOP_BAR_BUTTON_LABEL_CLASSNAME =
  "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5";
const EXPANDED_TOP_BAR_GROUP_SEPARATOR_CLASSNAME = "hidden @3xl/header-actions:block";

export function topBarButtonLabelClassName(compact: boolean): string {
  return compact ? "sr-only" : EXPANDED_TOP_BAR_BUTTON_LABEL_CLASSNAME;
}

export function topBarGroupSeparatorClassName(compact: boolean): string {
  return compact ? "hidden" : EXPANDED_TOP_BAR_GROUP_SEPARATOR_CLASSNAME;
}
