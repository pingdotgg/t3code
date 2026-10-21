import type { HomeListFilterMenuProject } from "./home-list-filter-menu";

/** Only the iOS pill menu needs image data; see the `.ios.ts` sibling. */
export function useProjectFilterMenuIcons<T extends HomeListFilterMenuProject>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T & { readonly image?: string }> {
  return projects;
}
