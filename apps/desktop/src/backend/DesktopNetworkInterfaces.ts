import { networkInterfaces } from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

export class DesktopNetworkInterfaces extends Context.Service<
  DesktopNetworkInterfaces,
  {
    readonly read: Effect.Effect<NetworkInterfaces>;
  }
>()("@t3tools/desktop/backend/DesktopNetworkInterfaces") {}

export const make = (): DesktopNetworkInterfaces["Service"] =>
  DesktopNetworkInterfaces.of({
    read: Effect.sync(() => networkInterfaces()),
  });

export const layer = Layer.succeed(DesktopNetworkInterfaces, make());
