import type { FlyMachineService } from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import type { MachineService } from "./Machine.ts";

/** One port, or an inclusive port range, published on Fly's proxy. */
export interface PublishedPort {
  protocol: string;
  start: number;
  end: number;
  handlers: string[];
  forceHttps: boolean;
}

export class ServicePortConflict extends Data.TaggedError(
  "Fly.ServicePortConflict",
)<{
  appName: string;
  port: number;
  protocol: string;
  /** The two publishers of the port: Service logical ids or Machine ids. */
  publishers: [string, string];
}> {
  get message() {
    return `Port ${this.port}/${this.protocol} in Fly App ${this.appName} is published by both ${this.publishers[0]} and ${this.publishers[1]}. Fly's proxy routes an App's traffic by port only, so give each Service in the App its own ports (\`services\`, or \`bindingPort\` for the plain-HTTP port Alchemy adds for bound callers).`;
  }
}

const normalize = (entry: {
  protocol?: string;
  port?: number;
  startPort?: number;
  endPort?: number;
  handlers?: string[];
  forceHttps?: boolean;
}): PublishedPort[] => {
  const start = entry.port ?? entry.startPort;
  const end = entry.port ?? entry.endPort ?? entry.startPort;
  if (start === undefined || end === undefined) return [];
  return [
    {
      protocol: entry.protocol ?? "tcp",
      start,
      end,
      handlers: entry.handlers ?? [],
      forceHttps: entry.forceHttps === true,
    },
  ];
};

/** Published ports of observed or desired Fly Machine services. */
export const portsOfFly = (
  services: readonly FlyMachineService[] | null | undefined,
): PublishedPort[] =>
  (services ?? []).flatMap((service) =>
    (service.ports ?? []).flatMap((port) =>
      normalize({
        protocol: service.protocol,
        port: port.port,
        startPort: port.start_port,
        endPort: port.end_port,
        handlers: port.handlers,
        forceHttps: port.force_https,
      }),
    ),
  );

/**
 * Published ports of a Service's `services` prop, falling back to the
 * defaults: HTTP 80 (redirecting to HTTPS) and HTTPS 443 when public,
 * plain HTTP 80 when private.
 */
export const portsOfProps = (
  services: readonly MachineService[] | undefined,
  isPublic: boolean,
): PublishedPort[] =>
  services !== undefined
    ? services.flatMap((service) =>
        (service.ports ?? []).flatMap((port) =>
          normalize({ protocol: service.protocol, ...port }),
        ),
      )
    : isPublic
      ? [
          {
            protocol: "tcp",
            start: 80,
            end: 80,
            handlers: ["http"],
            forceHttps: true,
          },
          {
            protocol: "tcp",
            start: 443,
            end: 443,
            handlers: ["tls", "http"],
            forceHttps: false,
          },
        ]
      : [
          {
            protocol: "tcp",
            start: 80,
            end: 80,
            handlers: ["http"],
            forceHttps: false,
          },
        ];

const isPlainHttp = (port: PublishedPort) =>
  port.start === port.end &&
  port.protocol === "tcp" &&
  port.handlers.includes("http") &&
  !port.handlers.includes("tls") &&
  !port.forceHttps;

/**
 * The port bound callers use: the first plain-HTTP port, since Fly issues
 * no certificate for `.flycast`. When the Service publishes ports but none
 * of them is plain HTTP, Alchemy publishes `bindingPort` for bindings.
 */
export const bindingPortOf = (
  ports: readonly PublishedPort[],
  bindingPort: number,
): { port: number; added: boolean } | undefined => {
  if (ports.length === 0) return undefined;
  const others = ports.filter(
    (port) => !(isPlainHttp(port) && port.start === bindingPort),
  );
  const plain = others.find(isPlainHttp);
  if (plain !== undefined) return { port: plain.start, added: false };
  return { port: bindingPort, added: true };
};

/** `ports` plus the binding port Alchemy adds, when it adds one. */
export const withBindingPort = (
  ports: readonly PublishedPort[],
  bindingPort: number,
): PublishedPort[] => {
  const binding = bindingPortOf(ports, bindingPort);
  return binding?.added === true &&
    !ports.some((port) => isPlainHttp(port) && port.start === bindingPort)
    ? [
        ...ports,
        {
          protocol: "tcp",
          start: bindingPort,
          end: bindingPort,
          handlers: ["http"],
          forceHttps: false,
        },
      ]
    : [...ports];
};

const overlaps = (left: PublishedPort, right: PublishedPort) =>
  left.protocol === right.protocol &&
  left.start <= right.end &&
  right.start <= left.end;

/**
 * The first port two publishers share, if any. A publisher that lists the
 * same port twice also conflicts with itself.
 */
export const findPortConflict = (
  appName: string,
  publishers: ReadonlyArray<{ id: string; ports: readonly PublishedPort[] }>,
): ServicePortConflict | undefined => {
  const flat = publishers.flatMap((publisher) =>
    publisher.ports.map((port) => ({ id: publisher.id, port })),
  );
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const left = flat[i]!;
      const right = flat[j]!;
      if (!overlaps(left.port, right.port)) continue;
      return new ServicePortConflict({
        appName,
        port: Math.max(left.port.start, right.port.start),
        protocol: left.port.protocol,
        publishers: [left.id, right.id],
      });
    }
  }
  return undefined;
};
