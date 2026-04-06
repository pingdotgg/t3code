import { ServiceMap } from "effect";

import type { GitManagerShape } from "../../git/Services/GitManager.ts";

export interface JjManagerShape extends GitManagerShape {}

export class JjManager extends ServiceMap.Service<JjManager, JjManagerShape>()(
  "t3/jj/Services/JjManager",
) {}
