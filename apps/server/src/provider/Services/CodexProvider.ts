import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface CodexProviderShape extends ServerProviderShape {}

export class CodexProvider extends Context.Service<CodexProvider, CodexProviderShape>()(
  "harness/provider/Services/CodexProvider",
) {}
