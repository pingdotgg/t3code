// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.

/**
 * Cloudflare Access identity binding for local dev, ported from Miniflare's
 * `workers/access/access-identity.worker.ts`. workerd dispatches
 * `ctx.access.getIdentity()` here with `{ aud, jwtClaims }` as `ctx.props`
 * (from the entry worker's access blob header); the claims are the identity.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

interface Props {
  aud: string;
  jwtClaims?: Record<string, unknown>;
}

export default class AccessIdentityBinding extends WorkerEntrypoint<Record<string, never>, Props> {
  async getIdentity(): Promise<Record<string, unknown> | undefined> {
    return this.ctx.props.jwtClaims;
  }
}
