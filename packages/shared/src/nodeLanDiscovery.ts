import Bonjour from "bonjour-service";
import * as NodeOS from "node:os";

export interface LanService {
  readonly id: string;
  readonly environmentId: string;
  readonly addresses: ReadonlyArray<string>;
  readonly port: number;
}

function interfaceAddresses(): string {
  return Object.values(NodeOS.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && entry.family === "IPv4")
    .map((entry) => entry.address)
    .sort()
    .join(",");
}

export function advertiseLanService(
  environmentId: string,
  port: number,
): { refresh: () => void; stop: () => void } {
  let current: { bonjour: Bonjour; service: Bonjour.Service } | undefined;
  const close = () => {
    const previous = current;
    current = undefined;
    if (previous) previous.service.stop(() => previous.bonjour.destroy());
  };
  const publish = () => {
    close();
    const bonjour = new Bonjour({}, () => {});
    const service = bonjour.publish({
      name: `T3 Code ${environmentId}`,
      type: "t3code",
      port,
      txt: { environmentId },
      disableIPv6: true,
      probe: false,
    });
    service.on("error", () => {});
    current = { bonjour, service };
  };
  let addresses = interfaceAddresses();
  publish();
  const refresh = () => {
    const next = interfaceAddresses();
    if (next === addresses) return;
    addresses = next;
    publish();
  };
  return { refresh, stop: close };
}

export function browseLanServices(onChange: (services: ReadonlyArray<LanService>) => void): {
  refresh: () => void;
  stop: () => void;
} {
  let bonjour: Bonjour | undefined;
  let browser: Bonjour.Browser | undefined;
  let stopped = false;
  const refresh = () => {
    if (stopped) return;
    browser?.stop();
    bonjour?.destroy();
    bonjour = new Bonjour({}, () => {});
    const current = bonjour.find({ type: "t3code", protocol: "tcp" });
    browser = current;
    const update = () => {
      if (browser !== current || stopped) return;
      onChange(
        current.services.flatMap((service): ReadonlyArray<LanService> => {
          const environmentId: unknown = service.txt?.environmentId;
          return typeof environmentId === "string"
            ? [
                {
                  id: service.fqdn,
                  environmentId,
                  addresses: service.addresses ?? [],
                  port: service.port,
                },
              ]
            : [];
        }),
      );
    };
    current.on("up", update);
    current.on("down", update);
    current.on("txt-update", update);
    current.on("srv-update", update);
    onChange([]);
  };
  refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      browser?.stop();
      bonjour?.destroy();
    },
  };
}
