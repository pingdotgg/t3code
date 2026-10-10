/**
 * A Hetzner Cloud app that exercises the full module-scope graph:
 *
 * - `Net` — private Network (`src/shared.ts`)
 * - `Box` — Server attached to the Network
 * - `Data` — Volume both Services mount via `Hetzner.MountVolume`
 * - `Wall` — Firewall (SSH + API) applied to the Server
 * - `Edge` — Load Balancer targeting the Server over the private IP
 * - `DnsZone` / `AppRecord` — optional DNS (`HETZNER_ZONE` for a real apex)
 * - `Api` — HTTP Service on port 3000 (`src/api.ts`)
 * - `Worker` — background Service that writes the volume marker (`src/worker.ts`)
 */
import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import {
  API_PORT,
  AppRecord,
  Box,
  Data,
  DnsZone,
  Edge,
  Net,
  Wall,
} from "./src/shared.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "HetznerApp",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const network = yield* Net;
    const server = yield* Box;
    const volume = yield* Data;
    const firewall = yield* Wall;
    const lb = yield* Edge;
    const worker = yield* Worker;
    const api = yield* Api;
    const dns =
      process.env.HETZNER_ZONE !== undefined &&
      process.env.HETZNER_ZONE.length > 0
        ? yield* Effect.all({ zone: DnsZone, records: AppRecord })
        : undefined;

    return {
      networkId: network.networkId,
      serverId: server.serverId,
      serverIpv4: server.ipv4,
      volumeId: volume.id,
      firewallId: firewall.id,
      loadBalancerId: lb.id,
      loadBalancerIpv4: lb.ipv4,
      loadBalancerUrl: Output.interpolate`http://${lb.ipv4}`,
      zoneId: dns?.zone.zoneId,
      zoneName: dns?.zone.name,
      recordName: dns?.records.name,
      apiUrl: api.url,
      apiPort: api.port,
      workerUnit: worker.unitName,
      enqueueExample: Output.interpolate`http://${server.ipv4}:${API_PORT}`,
    };
  }),
);
