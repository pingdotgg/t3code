import { Context, type Effect } from "effect";
import type { ProviderDriverKind, RuntimeMode } from "@t3tools/contracts";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: ProviderDriverKind;
  /**
   * Warms an agent process for `cwd`/`runtimeMode` so an imminent session start
   * pays only for `session/new`. Best effort: failures are swallowed.
   */
  readonly prewarmSession: (input: {
    readonly cwd: string;
    readonly runtimeMode: RuntimeMode;
  }) => Effect.Effect<void>;
}

export class CopilotAdapter extends Context.Service<CopilotAdapter, CopilotAdapterShape>()(
  "t3/provider/Services/CopilotAdapter",
) {}
