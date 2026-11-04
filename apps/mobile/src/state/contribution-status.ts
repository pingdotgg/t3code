import { createContributionStatusEnvironmentAtoms } from "@t3tools/client-runtime/state/contribution-status";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const contributionStatusEnvironment = createContributionStatusEnvironmentAtoms(
  connectionAtomRuntime,
  { configValueAtom: serverEnvironment.configValueAtom },
);
