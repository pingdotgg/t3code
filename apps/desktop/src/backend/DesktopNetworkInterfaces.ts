import * as NodeOS from "node:os";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface DesktopNetworkInterfaceInfo {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
  readonly netmask?: string;
  readonly mac?: string;
  readonly cidr?: string | null;
  readonly scopeid?: number;
}

export type NetworkInterfaces = Readonly<
  Record<string, readonly DesktopNetworkInterfaceInfo[] | undefined>
>;

// Some Node builds report the address family as the number 4/6 instead of
// "IPv4"/"IPv6" (see DesktopBackendConfiguration.isLocalHostIpv4).
export const isIpv4Family = (family: string | number): boolean => {
  const normalized = String(family);
  return normalized === "IPv4" || normalized === "4";
};

export class DesktopNetworkInterfacesReadError extends Schema.TaggedErrorClass<DesktopNetworkInterfacesReadError>()(
  "DesktopNetworkInterfacesReadError",
  {
    platform: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read desktop network interfaces on ${this.platform}.`;
  }
}

export class DesktopNetworkInterfaces extends Context.Service<
  DesktopNetworkInterfaces,
  {
    readonly read: Effect.Effect<NetworkInterfaces>;
  }
>()("@t3tools/desktop/backend/DesktopNetworkInterfaces") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return DesktopNetworkInterfaces.of({
    read: Effect.try({
      try: () => NodeOS.networkInterfaces(),
      catch: (cause) => new DesktopNetworkInterfacesReadError({ platform, cause }),
    }).pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(DesktopNetworkInterfaces, make);
