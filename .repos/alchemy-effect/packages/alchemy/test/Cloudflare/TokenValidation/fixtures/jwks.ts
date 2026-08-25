import type { JwkKey } from "@/Cloudflare/TokenValidation/Configuration";

/**
 * Checked-in RSA public JWKs for token validation tests. These are the
 * public halves of throwaway RSA-2048 keypairs generated once for this
 * fixture — the private halves were discarded, so the keys validate
 * nothing real and contain no secret material.
 *
 * Two keys with distinct `kid`s allow exercising key rotation
 * (`putConfigurationCredential`) deterministically across runs.
 */
export const JWKS_KEY_1: JwkKey = {
  kty: "RSA",
  alg: "RS256",
  kid: "alchemy-test-key-1",
  n: "zd-ngNj4MXXQqPPDy5-Hc87NiwFmjN-ar4BFJiFmxySdfTNv4WNzDgZyEvlUOF1fg8AVEehBIaF8tcAYEyJkt2IgCFcJfWLGCWmgU12DeNHIWfKqfxMJ9x5GZq-d0HVFOlpHIkOl28xH2DKEzLSwXGWIXOI-fHms2jYTnqNCDKFvBzdyXsnEC75dDiHm3qwklcYWovHRiKLyFJby5YKM83IZGYTe-fEjlequ21UAZNIACUZRB9B36tMLl6glWeqlSu-aYwbxLFT1PQIJgQ2ocHeIMCDOhrBbcwcEBb0bG_gFdd_Vco3K8SwhPPUmFP3yo1ToLey9XOxyr7UFmW8t0w",
  e: "AQAB",
};

export const JWKS_KEY_2: JwkKey = {
  kty: "RSA",
  alg: "RS256",
  kid: "alchemy-test-key-2",
  n: "sFb7irOp5QwrJXJnnYB0QptgIHStKpdd4RlW-2ZQanRwpNWcZruHM2PFIHlnzFUrf_01Ww-dZP5bG4xx0AAF3lR7TQ6_Luzk6QzXTrK827uXpVZN3lKFBaKwysYX6xk4ZTrfrMsZ0Qw_8Wtq8Jluhsj9NPE__9sO--BgEhJhlV6U8tE7AAP3nvHqi43m7WBP6AxA6ZjTh7EcaFj8jKvvqFdxcwnfGYZV2XOdgCorScBqdPzt8W_1ROw6_CdSg7-bko-psbcbOnXy-TyHRFTyaNVmSsiKSykEUJov0-IiAcO3Xn8TSpOXDEVlMD33ht24e6QYZSBTbaePWPKeLZEy1w",
  e: "AQAB",
};
