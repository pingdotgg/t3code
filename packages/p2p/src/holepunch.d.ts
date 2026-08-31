/**
 * Minimal typings for the untyped Holepunch modules this package consumes.
 * Only the surface used by the announcer, dialer, and tests is declared.
 */

declare module "hyperdht" {
  export interface P2pKeyPair {
    readonly publicKey: Buffer;
    readonly secretKey: Buffer;
  }

  /**
   * A Noise-encrypted duplex stream (streamx). Declared against the Node
   * stream surface so it can cross-pipe with `net.Socket`; streamx implements
   * the same `pipe`/`write`/`end`/event contract at runtime.
   */
  export interface NoiseSecretStream extends NodeJS.ReadWriteStream {
    readonly remotePublicKey: Buffer;
    readonly destroyed: boolean;
    destroy(error?: Error): void;
  }

  export interface P2pDhtServer {
    listen(keyPair: P2pKeyPair): Promise<void>;
    close(): Promise<void>;
    on(event: "connection", listener: (socket: NoiseSecretStream) => void): this;
  }

  export interface DhtOptions {
    readonly bootstrap?: ReadonlyArray<string | { readonly host: string; readonly port: number }>;
    readonly ephemeral?: boolean;
    readonly firewalled?: boolean;
    readonly port?: number;
    readonly keyPair?: P2pKeyPair;
  }

  export default class DHT {
    constructor(options?: DhtOptions);
    static keyPair(seed?: Buffer): P2pKeyPair;
    ready(): Promise<void>;
    destroy(): Promise<void>;
    connect(
      remotePublicKey: Buffer,
      options?: { readonly keyPair?: P2pKeyPair },
    ): NoiseSecretStream;
    createServer(
      options?: {
        readonly firewall?: (remotePublicKey: Buffer, remoteHandshakePayload: unknown) => boolean;
      },
      onconnection?: (socket: NoiseSecretStream) => void,
    ): P2pDhtServer;
  }
}

declare module "hyperdht/testnet" {
  import type DHT from "hyperdht";

  export interface Testnet {
    readonly bootstrap: ReadonlyArray<{ readonly host: string; readonly port: number }>;
    readonly nodes: ReadonlyArray<DHT>;
    destroy(): Promise<void>;
  }

  export default function createTestnet(size?: number): Promise<Testnet>;
}

declare module "z32" {
  const z32: {
    encode(buffer: Uint8Array): string;
    decode(value: string, out?: Uint8Array): Buffer;
  };
  export default z32;
}
