import { makeNeonTarget } from "../core/NeonServe.ts";
import { makeNodeTarget } from "./node.ts";

/** React Router loaders and actions served by a Neon Fetch handler. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeNeonTarget(makeNodeTarget(config));
export default target;
