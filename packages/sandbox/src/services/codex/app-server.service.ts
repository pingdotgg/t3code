import * as ServiceMap from "effect/ServiceMap";

import type { CodexServiceShape } from "./app-server.types";

export class CodexService extends ServiceMap.Service<CodexService, CodexServiceShape>()(
  "@repo/sandbox/services/codex/CodexService",
) {}
