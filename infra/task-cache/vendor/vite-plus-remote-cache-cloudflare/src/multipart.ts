import { Buffer } from 'node:buffer';
import { badRequest, tooLarge } from './errors.ts';
import { collect, Input } from './streams.ts';

export function parameters(raw: string): { type: string; params: Map<string, string> } {
  const separator = raw.indexOf(';');
  const type = (separator === -1 ? raw : raw.slice(0, separator)).trim().toLowerCase();
  let rest = separator === -1 ? '' : raw.slice(separator);
  const params = new Map<string, string>();
  while (rest.length) {
    const match = /^;\s*([\w-]+)\s*=\s*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([^\s;]+))\s*/.exec(rest);
    if (!match) badRequest();
    const name = match[1]!.toLowerCase();
    if (params.has(name)) badRequest();
    params.set(name, match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!);
    rest = rest.slice(match[0].length);
  }
  return { type, params };
}

export function boundaryFrom(contentType: string | null): string {
  const { type, params } = parameters(contentType ?? '');
  const boundary = params.get('boundary');
  if (
    type !== 'multipart/form-data' ||
    !boundary ||
    boundary.length > 70 ||
    !/^[0-9A-Za-z'()+_,./:=? -]+$/.test(boundary) ||
    boundary.endsWith(' ')
  )
    badRequest();
  return boundary;
}

export async function* multipart(
  input: Input,
  boundary: string,
  headerLimit: number,
): AsyncGenerator<{
  name: 'metadata' | 'blob';
  body: AsyncGenerator<Uint8Array>;
}> {
  let preamble = 0;
  while (true) {
    const line = await input.until(Buffer.from('\r\n'), headerLimit);
    preamble += line.length + 2;
    if (preamble > headerLimit) tooLarge();
    if (line.toString('utf8').replace(/[ \t]+$/, '') === `--${boundary}`) break;
  }
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const seen = new Set<string>();
  let closed = false;
  while (!closed) {
    if (seen.size >= 2) badRequest();
    const raw = await input.until(Buffer.from('\r\n\r\n'), headerLimit);
    const headers = new Map<string, string>();
    for (const line of raw.toString('utf8').split('\r\n')) {
      const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(line);
      if (!match) badRequest();
      const name = match[1]!.toLowerCase();
      if (headers.has(name)) badRequest();
      headers.set(name, match[2]!.trim());
    }
    const disposition = parameters(headers.get('content-disposition') ?? '');
    const name = disposition.params.get('name');
    if (
      disposition.type !== 'form-data' ||
      (name !== 'metadata' && name !== 'blob') ||
      seen.has(name)
    )
      badRequest();
    if (headers.has('content-transfer-encoding')) badRequest();
    const expected = name === 'metadata' ? 'application/cbor' : 'application/octet-stream';
    if (parameters(headers.get('content-type') ?? '').type !== expected) badRequest();
    seen.add(name);
    let consumed = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      while (true) {
        let index = input.buffer.indexOf(delimiter);
        while (index >= 0) {
          const match = await delimiterEnd(input, index + delimiter.length, headerLimit);
          if (match) {
            if (index) yield input.take(index);
            input.take(match.end - index);
            closed = match.closed;
            consumed = true;
            return;
          }
          index = input.buffer.indexOf(delimiter, index + 1);
        }
        const safe = input.buffer.length - delimiter.length - 2;
        if (safe > 0) yield input.take(safe);
        if (!(await input.fill())) badRequest();
      }
    }
    yield { name, body: body() };
    if (!consumed) throw new Error('Multipart consumer must drain each part');
  }
  if (!seen.has('metadata')) badRequest();
  await collect(input.rest(), headerLimit);
}

async function delimiterEnd(
  input: Input,
  start: number,
  limit: number,
): Promise<{ end: number; closed: boolean } | null> {
  while (input.buffer.length < start + 2 && (await input.fill())) {}
  const closed = input.buffer[start] === 45 && input.buffer[start + 1] === 45;
  let end = start + (closed ? 2 : 0);
  while (true) {
    while (input.buffer.length < end + 2 && (await input.fill())) {}
    if (input.buffer[end] !== 32 && input.buffer[end] !== 9) break;
    if (++end - start > limit) tooLarge();
  }
  if (input.buffer[end] === 13 && input.buffer[end + 1] === 10) return { end: end + 2, closed };
  if (closed && input.ended && end === input.buffer.length) return { end, closed };
  // A boundary prefix followed by arbitrary bytes is still part of the opaque body.
  return null;
}
