import type { AcpAgentServer, ServerAcpAgentStatus, ServerSettingsError } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface AcpAgentRegistryShape {
  readonly listStatuses: Effect.Effect<ReadonlyArray<ServerAcpAgentStatus>, ServerSettingsError>;
  readonly getAgentServers: Effect.Effect<ReadonlyArray<AcpAgentServer>, ServerSettingsError>;
}

export class AcpAgentRegistry extends Context.Service<AcpAgentRegistry, AcpAgentRegistryShape>()(
  "t3/provider/Services/AcpAgentRegistry",
) {}
