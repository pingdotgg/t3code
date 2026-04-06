import { ServiceMap } from "effect";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";

export interface JjCoreShape extends GitCoreShape {}

export class JjCore extends ServiceMap.Service<JjCore, JjCoreShape>()("t3/jj/Services/JjCore") {}
