// @effect-diagnostics globalDate:off globalFetch:off - vendored upstream protocol, not an Effect service.
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { HttpError, unavailable } from './errors.ts';
import { Deadline, readBody } from './streams.ts';
import type { Scope } from './database.ts';

export const ISSUER = 'https://token.actions.githubusercontent.com';
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;

export function githubKeys(): JWTVerifyGetKey {
  // Only reusable public-key cache state lives across requests. Failed refreshes
  // also have a cooldown; jose's own cooldown starts only after a successful fetch.
  let lastAttempt = -Infinity;
  return createRemoteJWKSet(new URL(JWKS_URL), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    [customFetch]: async (url, options) => {
      if (Date.now() - lastAttempt < 30_000) unavailable();
      lastAttempt = Date.now();
      const deadline = new Deadline(5000, options.signal);
      try {
        const response = await deadline.run(fetch(url, options));
        if (response.status !== 200) {
          void response.body?.cancel();
          unavailable();
        }
        const bytes = await readBody(response.body, 64 * 1024, deadline);
        return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
      } catch {
        unavailable();
      } finally {
        deadline.dispose();
      }
    },
  });
}

export interface WriteIdentity {
  exp: number;
  repository_id: string;
  workflow_ref?: string;
  run_id?: string;
  run_attempt?: string;
  sha?: string;
  event_name?: string;
  head_ref?: string;
}

export async function authorize(
  request: Request,
  scope: Scope,
  keys: JWTVerifyGetKey,
): Promise<WriteIdentity> {
  const authorization = request.headers.get('Authorization');
  if (
    !authorization ||
    authorization.length > 16 * 1024 ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)
  ) {
    throw new HttpError(401, 'invalid_token');
  }
  const token = authorization.slice(7);
  let payload: JWTPayload;
  try {
    const header = decodeProtectedHeader(token);
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      header.kid.length > 256 ||
      header.jku ||
      header.x5u ||
      header.jwk
    ) {
      throw new HttpError(401, 'invalid_token');
    }
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: ISSUER,
      requiredClaims: ['exp', 'nbf', 'iat'],
      clockTolerance: 30,
      maxTokenAge: '15 minutes',
    }));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JOSENotSupported ||
      error instanceof errors.JWKSNoMatchingKey ||
      error instanceof errors.JOSEAlgNotAllowed
    ) {
      throw new HttpError(401, 'invalid_token');
    }
    unavailable();
  }
  const now = Date.now() / 1000;
  const { exp, nbf, iat } = payload;
  if (
    typeof exp !== 'number' ||
    typeof nbf !== 'number' ||
    typeof iat !== 'number' ||
    !Number.isSafeInteger(exp) ||
    !Number.isSafeInteger(nbf) ||
    !Number.isSafeInteger(iat) ||
    exp <= now ||
    nbf > now + 30 ||
    iat > now + 30 ||
    iat < now - 930 ||
    nbf > exp ||
    iat >= exp ||
    exp - iat > 900
  ) {
    throw new HttpError(401, 'invalid_token');
  }
  // A `push` must update the registered branch. A namespace that opts in also accepts
  // `pull_request` runs whose PR targets that branch. For those, GitHub signs `ref`
  // `refs/pull/<number>/merge`, `ref_type` `branch`, and the target branch's short name (`main`)
  // in `base_ref`. The `closed` run of a merged PR has the base branch in `ref` and is denied.
  // Fork PR runs carry the base repository's IDs too; only GitHub withholding `id-token: write`
  // from them keeps them out.
  const event =
    payload.event_name === 'push'
      ? payload.ref === scope.branch
      : payload.event_name === 'pull_request' &&
        scope.pull_requests === 1 &&
        typeof payload.ref === 'string' &&
        /^refs\/pull\/[1-9][0-9]*\/merge$/.test(payload.ref) &&
        typeof payload.base_ref === 'string' &&
        `refs/heads/${payload.base_ref}` === scope.branch;
  if (
    !scope.writes_enabled ||
    payload.aud !== scope.endpoint ||
    payload.repository_id !== scope.repository_id ||
    payload.repository_owner_id !== scope.repository_owner_id ||
    payload.repository_visibility !== 'public' ||
    payload.ref_type !== 'branch' ||
    !event
  ) {
    throw new HttpError(403, 'write_policy');
  }
  const identity: WriteIdentity = { exp, repository_id: scope.repository_id };
  for (const name of [
    'workflow_ref',
    'run_id',
    'run_attempt',
    'sha',
    'event_name',
    'head_ref',
  ] as const) {
    const value = payload[name];
    if (typeof value === 'string' && value && value.length <= 512) identity[name] = value;
  }
  return identity;
}
