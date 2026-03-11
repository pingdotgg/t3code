import type { ServerProviderStatus } from "@t3tools/contracts";
import type { ReplayFixture, ReplayInteraction } from "@t3tools/rr-e2e";

export type Fixture = ReplayFixture<ServerProviderStatus>;
export type Interaction = ReplayInteraction;
