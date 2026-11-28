import { cborResponse, cborString, decodeEnvelope, header } from './cbor.ts';
import { selectEntries } from './database.ts';
import { badRequest, HttpError, unavailable } from './errors.ts';
import type { Limits } from './limits.ts';
import { parameters } from './multipart.ts';
import type { Observations } from './observations.ts';
import { contentLength, Deadline, readBody } from './streams.ts';

export async function fetchMetadata(
  request: Request,
  env: Pick<Env, 'INDEX' | 'ARTIFACTS'>,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  scope: string,
  limits: Limits,
  deadline: Deadline,
  stats: Observations,
): Promise<{ kind: 'exact' | 'fallback'; response: Response }> {
  if (parameters(request.headers.get('Content-Type') ?? '').type !== 'application/cbor')
    badRequest();
  contentLength(request, limits.fetch);
  const body = await readBody(request.body, limits.fetch, deadline);
  stats.request_bytes = body.length;
  const data = decodeEnvelope(body, false, limits);
  const selected = await deadline.run(
    selectEntries(env.INDEX, scope, data.key, data.secondary_key, stats),
  );
  if (!selected) throw new HttpError(404, 'miss');
  // Fallbacks only identify the associated key. They must not depend on R2 availability.
  if (selected.kind === 'fallback')
    return { kind: 'fallback', response: cborResponse({ kind: 'fallback', key: selected.key }) };

  const { entries } = selected;
  stats.r2_operations += entries.length;
  const settled = await deadline
    .run(Promise.allSettled(entries.map((entry) => env.ARTIFACTS.get(entry.value_object))))
    .catch(() => unavailable());
  const objects = settled.map((result) => (result.status === 'fulfilled' ? result.value : null));
  // Check every value before responding, so a missing, failed, or resized object is still a 503.
  if (
    objects.some(
      (object, i) =>
        !object || object.size !== entries[i]!.value_size || object.size > limits.value,
    )
  ) {
    for (const object of objects) object?.body.cancel().catch(() => {});
    unavailable();
  }

  // { kind: "exact", entries: [{ value, blob_id }] }, newest first. Values stream from R2,
  // so a response with many large values isn't held in memory.
  const parts: (Uint8Array | ReadableStream<Uint8Array>)[] = [
    header(5, 2),
    ...cborString('kind'),
    ...cborString('exact'),
    ...cborString('entries'),
    header(4, entries.length),
  ];
  for (const [i, entry] of entries.entries()) {
    parts.push(header(5, 2), ...cborString('value'), header(2, entry.value_size));
    parts.push(objects[i]!.body);
    parts.push(...cborString('blob_id'));
    if (entry.blob_id === null) parts.push(Uint8Array.of(246));
    else parts.push(...cborString(entry.blob_id));
  }
  const length =
    parts.reduce((sum, part) => sum + (part instanceof Uint8Array ? part.length : 0), 0) +
    entries.reduce((sum, entry) => sum + entry.value_size, 0);
  const stream = new FixedLengthStream(length);
  ctx.waitUntil(pump(parts, stream.writable));
  return {
    kind: 'exact',
    response: new Response(stream.readable, {
      headers: {
        'Content-Type': 'application/cbor',
        'Content-Length': String(length),
        'Cache-Control': 'no-store',
      },
    }),
  };
}

// Write `parts` in order, copying each stream's chunks. If the client cancels the response, the
// writable errors: the stream being copied is cancelled, so a pending read can't keep it open, and
// so are the streams not reached yet.
export async function pump(
  parts: (Uint8Array | ReadableStream<Uint8Array>)[],
  writable: WritableStream<Uint8Array>,
): Promise<void> {
  const writer = writable.getWriter();
  let active: ReadableStreamDefaultReader<Uint8Array> | undefined;
  writer.closed.catch(() => active?.cancel().catch(() => {}));
  let next = 0;
  try {
    for (; next < parts.length; next++) {
      const part = parts[next]!;
      if (part instanceof Uint8Array) {
        await writer.write(part);
        continue;
      }
      active = part.getReader();
      for (;;) {
        const { done, value } = await active.read();
        if (done) break;
        await writer.write(value);
      }
      active = undefined;
    }
    await writer.close();
  } catch (error) {
    // A truncated body fails the client's CBOR decoding, which it treats as a failed read.
    await writer.abort(error).catch(() => {});
    await active?.cancel().catch(() => {});
    for (const part of parts.slice(next + 1))
      if (!(part instanceof Uint8Array)) await part.cancel().catch(() => {});
  }
}
