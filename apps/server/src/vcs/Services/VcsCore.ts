import { ServiceMap } from "effect";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";

export interface VcsCoreShape extends GitCoreShape {}

export class VcsCore extends ServiceMap.Service<VcsCore, VcsCoreShape>()(
  "t3/vcs/Services/VcsCore",
) {}
