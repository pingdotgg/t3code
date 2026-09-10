import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FlyAppExample",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Fly.App("Site");
    const ip = yield* Fly.IpAssignment("Shared", {
      app: site,
      type: "shared_v4",
    });
    const web = yield* Fly.Machine("Web", {
      app: site,
      region: "iad",
      image: "nginx:alpine",
      guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
      services: [
        {
          protocol: "tcp",
          internalPort: 80,
          ports: [
            { port: 80, handlers: ["http"], forceHttps: true },
            { port: 443, handlers: ["tls", "http"] },
          ],
        },
      ],
    });

    return {
      url: site.url,
      ip: ip.ip,
      machineId: web.machineId,
    };
  }),
);
