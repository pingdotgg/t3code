import type { Daytona } from "@daytonaio/sdk";
import * as ServiceMap from "effect/ServiceMap";

export interface DaytonaClientLayerOptions {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly target?: string;
}

export interface DaytonaClientShape {
  readonly client: Daytona;
}

export class DaytonaClient extends ServiceMap.Service<DaytonaClient, DaytonaClientShape>()(
  "@repo/sandbox/client/DaytonaClient",
) {}
