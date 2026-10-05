import { makeNeonTarget } from "../core/NeonServe.ts";
import { makeNodeTarget } from "./node.ts";

/** Astro static and SSR output served through Neon's Fetch interface. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeNeonTarget(makeNodeTarget(config));
export default target;
