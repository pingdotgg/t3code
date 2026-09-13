import * as Hetzner from "@/Hetzner";
import * as Effect from "effect/Effect";

export const VOLUME_PATH = "/var/lib/api";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-worker";
export const API_PORT = 3000;

export const Box = Hetzner.Server("Box", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "nbg1",
});

export const Data = Hetzner.Volume("Data", {
  size: 10,
  format: "ext4",
  location: "nbg1",
});

export const Wall = Hetzner.Firewall(
  "Wall",
  Effect.gen(function* () {
    const server = yield* Box;
    return {
      applyTo: [server],
      rules: [
        {
          direction: "in" as const,
          protocol: "tcp" as const,
          port: "22",
          sourceIps: ["0.0.0.0/0", "::/0"],
          description: "ssh",
        },
        {
          direction: "in" as const,
          protocol: "tcp" as const,
          port: String(API_PORT),
          sourceIps: ["0.0.0.0/0", "::/0"],
          description: "api",
        },
      ],
    };
  }),
);

export const Edge = Hetzner.LoadBalancer(
  "Edge",
  Effect.gen(function* () {
    const server = yield* Box;
    return {
      location: "nbg1",
      loadBalancerType: "lb11",
      services: [
        {
          protocol: "http" as const,
          listenPort: 80,
          destinationPort: API_PORT,
          healthCheck: {
            protocol: "http" as const,
            port: API_PORT,
            interval: 3,
            timeout: 2,
            retries: 2,
            http: { path: "/health" },
          },
        },
      ],
      targets: [{ type: "server" as const, server }],
    };
  }),
);

export const DnsZone = Hetzner.Zone("AppZone", {
  ttl: 300,
});

export const AppRecord = Hetzner.RecordSet(
  "App",
  Effect.flatMap(Edge, (lb) =>
    Effect.map(DnsZone, (zone) => ({
      zone,
      name: "app",
      type: "A" as const,
      records: [{ value: lb.ipv4.as<string>() }],
      ttl: 300,
    })),
  ),
);
