import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderVectorIcon,
  ServerProvider,
} from "@t3tools/contracts";
import type * as Stream from "effect/Stream";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

export type ProviderSnapshotSource = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly icon: ProviderVectorIcon | undefined;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
