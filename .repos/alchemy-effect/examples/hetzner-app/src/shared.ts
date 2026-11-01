import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export const VOLUME_PATH = "/data";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-worker";
export const API_PORT = 3000;

/**
 * Private Network both the Server and Load Balancer attach to.
 * nbg1 lives in `eu-central`.
 */
export const Net = Hetzner.Network("Network", {
  ipRange: "10.42.0.0/16",
  subnets: [
    {
      type: "cloud",
      ipRange: "10.42.1.0/24",
      networkZone: "eu-central",
    },
  ],
});

/**
 * The box both Services share. Alchemy injects a deploy SSH key so
 * `Hetzner.Service` can copy the bundled unit over SSH.
 */
export const Box = Hetzner.Server(
  "Box",
  Effect.gen(function* () {
    const network = yield* Net;
    return {
      serverType: "cpx12",
      image: "ubuntu-24.04",
      location: "nbg1",
      networks: [network],
    };
  }),
);

/** Shared Volume both Services mount at {@link VOLUME_PATH}. */
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
    const network = yield* Net;
    return {
      location: "nbg1",
      loadBalancerType: "lb11",
      networks: [network],
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
      targets: [{ type: "server" as const, server, usePrivateIp: true }],
    };
  }),
);

/**
 * Optional DNS: yielded from the stack only when `HETZNER_ZONE` is set
 * (a real apex). Changing the name replaces the Zone.
 */
export const DnsZone = Hetzner.Zone("AppZone", {
  name: process.env.HETZNER_ZONE,
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
