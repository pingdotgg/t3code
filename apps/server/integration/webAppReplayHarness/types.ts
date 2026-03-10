import type { ServerProviderStatus } from "@t3tools/contracts";
import type {
  ReplayFixture as BaseReplayFixture,
  ReplayInteraction,
  ReplayRef,
  ReplayScopes,
  ResolvedInteraction,
} from "@t3tools/rr-e2e";

export type ReplayFixture = BaseReplayFixture<ServerProviderStatus>;

export type { ReplayInteraction, ReplayRef, ReplayScopes, ResolvedInteraction };
