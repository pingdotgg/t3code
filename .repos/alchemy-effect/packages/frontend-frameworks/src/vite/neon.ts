import { makeNeonTarget } from "../core/NeonServe.ts";
import { makeNodeTarget } from "./node.ts";

/** Vite assets served by a Neon Function, with native Vite development. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeNeonTarget(makeNodeTarget(config));
export default target;
