import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { LocalServerPairingChallenge } from "./localServerDiscovery.ts";

const decodePairingChallenge = Schema.decodeUnknownSync(LocalServerPairingChallenge);

it("preserves filesystem-significant whitespace in pairing challenge paths", () => {
  const challenge = decodePairingChallenge({
    instanceId: "instance-local",
    challengePath: " /tmp/t3code challenge ",
    nonce: "nonce",
  });

  expect(challenge.challengePath).toBe(" /tmp/t3code challenge ");
});
