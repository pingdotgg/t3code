import { ServiceMap } from "effect";

import type { GitManagerShape } from "../../git/Services/GitManager.ts";

export interface VcsManagerShape extends GitManagerShape {}

export class VcsManager extends ServiceMap.Service<VcsManager, VcsManagerShape>()(
  "t3/vcs/Services/VcsManager",
) {}
