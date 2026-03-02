import {
  OrchestrationEvent,
  OrchestrationReadModel,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WsWelcomePayload,
} from "@t3tools/contracts";
import { Cause, Schema } from "effect";

import { buildSocketUrl, type BackendProfile } from "./backendProfiles";
import { type TransportStatus, WsTransport } from "./wsTransport";

const decodeWelcomePayload = Schema.decodeUnknownExit(WsWelcomePayload);
const decodeOrchestrationEvent = Schema.decodeUnknownExit(OrchestrationEvent);
const decodeOrchestrationReadModel = Schema.decodeUnknownExit(OrchestrationReadModel);

export class T3MobileClient {
  private readonly transport: WsTransport;

  constructor(options: {
    readonly profile: Pick<BackendProfile, "url" | "authToken">;
    readonly onStatus?: (status: TransportStatus) => void;
  }) {
    this.transport = new WsTransport(buildSocketUrl(options.profile), options.onStatus);
  }

  getSnapshot = async (): Promise<typeof OrchestrationReadModel.Type> => {
    const raw = await this.transport.request(ORCHESTRATION_WS_METHODS.getSnapshot);
    const decoded = decodeOrchestrationReadModel(raw);
    if (decoded._tag === "Failure") {
      throw new Error(`Invalid orchestration snapshot payload: ${Cause.pretty(decoded.cause)}`);
    }
    return decoded.value;
  };

  onWelcome = (callback: (payload: typeof WsWelcomePayload.Type) => void): (() => void) =>
    this.transport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
      const decoded = decodeWelcomePayload(data);
      if (decoded._tag === "Failure") {
        console.warn("Dropped server welcome payload", { issue: Cause.pretty(decoded.cause) });
        return;
      }
      callback(decoded.value);
    });

  onDomainEvent = (callback: (event: typeof OrchestrationEvent.Type) => void): (() => void) =>
    this.transport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (data) => {
      const decoded = decodeOrchestrationEvent(data);
      if (decoded._tag === "Failure") {
        console.warn("Dropped orchestration domain event", { issue: Cause.pretty(decoded.cause) });
        return;
      }
      callback(decoded.value);
    });

  dispose(): void {
    this.transport.dispose();
  }
}
