import { decodeEnvelope } from './cbor.ts';
import { selectEntry } from './database.ts';
import { badRequest, HttpError, unavailable } from './errors.ts';
import type { Limits } from './limits.ts';
import { parameters } from './multipart.ts';
import type { Observations } from './observations.ts';
import { contentLength, Deadline, readBody } from './streams.ts';

type FetchResult =
  | { kind: 'exact'; value: Uint8Array; blob_id: string | null }
  | { kind: 'fallback'; key: Uint8Array };

export async function fetchMetadata(
  request: Request,
  env: Pick<Env, 'INDEX' | 'ARTIFACTS'>,
  scope: string,
  limits: Limits,
  deadline: Deadline,
  stats: Observations,
): Promise<FetchResult> {
  if (parameters(request.headers.get('Content-Type') ?? '').type !== 'application/cbor')
    badRequest();
  contentLength(request, limits.fetch);
  const body = await readBody(request.body, limits.fetch, deadline);
  stats.request_bytes = body.length;
  const data = decodeEnvelope(body, false, limits);
  const selected = await deadline.run(
    selectEntry(env.INDEX, scope, data.key, data.secondary_key, stats),
  );
  if (!selected) throw new HttpError(404, 'miss');
  // Fallbacks only identify the associated key. They must not depend on R2 availability.
  if (selected.kind === 'fallback') return { kind: 'fallback', key: new Uint8Array(selected.key) };

  stats.r2_operations++;
  const object = await deadline
    .run(env.ARTIFACTS.get(selected.value_object))
    .catch(() => unavailable());
  if (!object || object.size !== selected.value_size || object.size > limits.value) unavailable();
  const value = await readBody(object.body, limits.value, deadline).catch(() => unavailable());
  if (value.length !== selected.value_size) unavailable();
  return { kind: 'exact', value, blob_id: selected.blob_id };
}
