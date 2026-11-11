import { makeNeonTarget } from "../core/NeonServe.ts";
import { makeNodeTarget } from "./node.ts";

/** Nuxt's Node handler adapted to Neon's Fetch interface. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeNeonTarget(makeNodeTarget(config));
export default target;
