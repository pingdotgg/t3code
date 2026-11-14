import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { MuseAdapterV2Options } from "./adapter.ts";
import { makeMuseSessionCore } from "./museSessionCore.ts";
import { makeMuseSessionEvents } from "./museSessionEvents.ts";
import { makeMuseSessionLifecycle } from "./museSessionLifecycle.ts";

/** Everything the session runtime needs from the adapter that owns it. */
export interface MuseSessionDeps {
  readonly options: MuseAdapterV2Options;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerHost: ProviderHost.ProviderHost["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly agentScope: AgentScopeShape;
}

export const makeMuseOpenSession = (deps: MuseSessionDeps) =>
  Effect.fn("MuseAdapterV2.openSession")(
    function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
      const core = yield* makeMuseSessionCore({ input, ...deps });
      const events = yield* makeMuseSessionEvents(core);
      const lifecycle = yield* makeMuseSessionLifecycle(core, events);
      return lifecycle;
    },
  );
