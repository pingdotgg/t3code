// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

export interface TarEntry {
  readonly path: string;
  /**
   * Tar type flag: `0` file (default), `5` directory, `1` hard link, `2` symlink, `3` device,
   * `g` pax global header (its `data` is the records).
   */
  readonly type?: string;
  readonly data?: string | Uint8Array;
  readonly mode?: number;
  readonly linkname?: string;
  /** Extra pax records written before this entry, as raw `key=value` bytes. */
  readonly pax?: ReadonlyArray<Uint8Array>;
  /** The header's size field when it is not the data's length, like a directory's reserved space. */
  readonly size?: number;
  /** `gnu` writes GNU's `ustar  ` magic, which keeps an access time where POSIX has the prefix. */
  readonly format?: "gnu";
}

const BLOCK = 512;
const encoder = new TextEncoder();

const header = (
  name: string,
  type: string,
  size: number,
  mode: number,
  linkname = "",
  format?: "gnu",
) => {
  const block = new Uint8Array(BLOCK);
  const put = (value: string, start: number, length: number) =>
    block.set(encoder.encode(value).subarray(0, length), start);
  const octal = (value: number, start: number, length: number) =>
    put(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length);
  put(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  put(type, 156, 1);
  put(linkname, 157, 100);
  if (format === "gnu") {
    put("ustar  \0", 257, 8);
    octal(0o14712345670, 345, 12);
  } else {
    put("ustar\0", 257, 6);
    put("00", 263, 2);
  }
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
};

const padded = (data: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(data);
  return out;
};

/** `<length> <key=value>\n`, where the length counts itself. */
export const paxRecord = (keyValue: Uint8Array) => {
  let length = keyValue.length + 2;
  while (`${length}`.length + keyValue.length + 2 !== length)
    length = `${length}`.length + keyValue.length + 2;
  return Buffer.concat([encoder.encode(`${length} `), keyValue, encoder.encode("\n")]);
};

/** An uncompressed tar of `entries`; names over 100 bytes get a pax header. */
export const makeTar = (entries: ReadonlyArray<TarEntry>) => {
  const blocks: Array<Uint8Array> = [];
  for (const entry of entries) {
    const type = entry.type ?? "0";
    const data =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    let name = entry.path;
    const records = [...(entry.pax ?? [])];
    if (encoder.encode(name).length > 100) {
      records.push(encoder.encode(`path=${name}`));
      name = name.slice(-100);
    }
    if (records.length > 0) {
      const pax = Buffer.concat(records.map(paxRecord));
      blocks.push(header("PaxHeader", "x", pax.length, 0o644), padded(pax));
    }
    const hasData = type === "0" || type === "g";
    blocks.push(
      header(
        name,
        type,
        entry.size ?? (hasData ? data.length : 0),
        entry.mode ?? (type === "5" ? 0o755 : 0o644),
        entry.linkname,
        entry.format,
      ),
    );
    if (hasData) blocks.push(padded(data));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  return Buffer.concat(blocks);
};

export const makeTarball = (entries: ReadonlyArray<TarEntry>) =>
  NodeZlib.gzipSync(makeTar(entries));

export const integrityOf = (bytes: Uint8Array) =>
  `sha512-${NodeCrypto.createHash("sha512").update(bytes).digest("base64")}`;

export const REGISTRY = "https://registry.test";

export interface RegistryVersion {
  readonly tarball: Uint8Array;
  /** Defaults to the tarball's real integrity. */
  readonly integrity?: string | undefined;
  /** Bytes served instead of `tarball`, to model a tampered download. */
  readonly served?: Uint8Array;
  /** The version the registry claims, if not the requested one. */
  readonly claimedVersion?: string;
}

/**
 * An in-memory npm registry: `GET /<name>/<version-or-tag>` and the tarballs
 * it points to, on any host. `offline` makes every request fail like a dropped
 * network; `redirects` answers a request URL with a 302 to another.
 */
export const makeRegistry = () => {
  const packages = new Map<string, Map<string, RegistryVersion>>();
  const tags = new Map<string, Map<string, string>>();
  const requests: Array<string> = [];
  const state = { offline: false };
  const redirects = new Map<string, string>();
  const publish = (name: string, version: string, published: RegistryVersion) => {
    const versions = packages.get(name) ?? new Map<string, RegistryVersion>();
    versions.set(version, published);
    packages.set(name, versions);
  };
  const tag = (name: string, tagName: string, version: string) => {
    const named = tags.get(name) ?? new Map<string, string>();
    named.set(tagName, version);
    tags.set(name, named);
  };
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      requests.push(url.href);
      if (state.offline)
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "offline" }),
          }),
        );
      const respond = (response: Response) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response));
      const location = redirects.get(url.href);
      if (location !== undefined)
        return respond(new Response(null, { status: 302, headers: { location } }));
      const tarball = /^\/tarballs\/(.+)\/-\/(.+)\.tgz$/.exec(url.pathname);
      if (tarball) {
        const name = decodeURIComponent(tarball[1]!);
        const published = packages.get(name)?.get(tarball[2]!);
        return published
          ? respond(new Response(published.served ?? published.tarball))
          : respond(new Response("missing", { status: 404 }));
      }
      const [encodedName, request_] = url.pathname.slice(1).split(/\/(?=[^/]+$)/);
      const name = decodeURIComponent(encodedName ?? "");
      const requested = decodeURIComponent(request_ ?? "");
      const version = tags.get(name)?.get(requested) ?? requested;
      const published = packages.get(name)?.get(version);
      if (published === undefined) return respond(new Response("{}", { status: 404 }));
      return respond(
        Response.json({
          name,
          version: published.claimedVersion ?? version,
          dist: {
            tarball: `${REGISTRY}/tarballs/${encodeURIComponent(name)}/-/${version}.tgz`,
            ...(published.integrity === undefined && "integrity" in published
              ? {}
              : { integrity: published.integrity ?? integrityOf(published.tarball) }),
          },
        }),
      );
    }),
  );
  return { client, publish, tag, requests, state, redirects };
};
