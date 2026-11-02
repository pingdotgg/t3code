import * as Schema from "effect/Schema";

export const LanDiscoveryService = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(255)),
  environmentId: Schema.String.check(Schema.isMaxLength(255)),
  addresses: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
    Schema.isMaxLength(32),
  ),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
export type LanDiscoveryService = typeof LanDiscoveryService.Type;

export const LanDiscoveryChallenge = Schema.Struct({
  payload: Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const LanDiscoveryProof = Schema.Struct({
  proof: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});

export function lanDiscoveryProofMessage(
  nonce: string,
  environmentId: string,
  address: string,
  port: number,
): string {
  return JSON.stringify(["t3code-lan-proof-v1", nonce, environmentId, address, port]);
}
