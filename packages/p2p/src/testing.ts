/// <reference path="./holepunch.d.ts" />
import createTestnet from "hyperdht/testnet";

export interface LocalDhtTestnet {
  /** host:port entries in the shape the announcer and dialer accept. */
  readonly bootstrap: ReadonlyArray<string>;
  readonly destroy: () => Promise<void>;
}

/** Boots an in-process DHT for tests; never touches the public network. */
export async function createLocalDhtTestnet(size = 3): Promise<LocalDhtTestnet> {
  const testnet = await createTestnet(size);
  return {
    bootstrap: testnet.bootstrap.map(({ host, port }) => `${host}:${port}`),
    destroy: () => testnet.destroy(),
  };
}
