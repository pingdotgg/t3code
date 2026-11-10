import type { LayoutServerLoad } from "./$types";

/**
 * Layout data for the `(marketing)` route group — the group segment must not
 * appear in URLs, while every page in the group inherits this data.
 */
export const load: LayoutServerLoad = ({ platform }) => {
  return {
    section: "marketing",
    layoutSecret: platform?.env?.FIXTURE_SECRET ?? "no-platform-env",
  };
};
