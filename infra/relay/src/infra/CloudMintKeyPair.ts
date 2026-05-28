import * as NodeCrypto from "node:crypto";

import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export type CloudMintKeyPair = Alchemy.Resource<
  "T3CodeRelay.CloudMintKeyPair",
  Record<string, never>,
  {
    readonly privateKey: Redacted.Redacted<string>;
    readonly publicKey: Redacted.Redacted<string>;
  }
>;

export const CloudMintKeyPair = Alchemy.Resource<CloudMintKeyPair>("T3CodeRelay.CloudMintKeyPair");

export const makeCloudMintKeyPair = Effect.sync(() => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });

  return {
    privateKey: Redacted.make(privateKey),
    publicKey: Redacted.make(publicKey),
  };
});

export const CloudMintKeyPairProvider = () =>
  Provider.succeed(CloudMintKeyPair, {
    reconcile: Effect.fn(function* ({ output }) {
      if (output?.privateKey && output.publicKey) {
        return output;
      }

      return yield* makeCloudMintKeyPair;
    }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  });
