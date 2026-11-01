import { createSkillEnvironmentAtoms } from "@t3tools/client-runtime/state/skills";

import { connectionAtomRuntime } from "../connection/runtime";

export const skillEnvironment = createSkillEnvironmentAtoms(connectionAtomRuntime);
