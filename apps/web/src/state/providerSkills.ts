import { createProviderSkillsEnvironmentAtoms } from "@t3tools/client-runtime/state/providerSkills";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerSkillsEnvironment =
  createProviderSkillsEnvironmentAtoms(connectionAtomRuntime);
