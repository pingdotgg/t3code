import type { ClientSettings } from "@t3tools/contracts/settings";

/** What the sidebar settings add up to; Detailed and Slim lock the rest without rewriting them. */
export function resolveSidebarLayout(
  settings: Pick<
    ClientSettings,
    | "sidebarVariant"
    | "boringSidebarEnabled"
    | "boringSidebarMultilineRows"
    | "sidebarWorkingShelfEnabled"
  >,
) {
  const locked = settings.sidebarVariant !== "default";
  const folders = locked || settings.boringSidebarEnabled;
  return {
    locked,
    folders,
    workingSection: !folders && settings.sidebarWorkingShelfEnabled,
    twoLineRows: locked
      ? settings.sidebarVariant === "detailed"
      : settings.boringSidebarMultilineRows,
  };
}
