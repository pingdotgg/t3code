/**
 * The import alarm job's git client (DESIGN.md §2.3 Import).
 *
 * A minimal **smart-HTTP protocol v0 client**: fetches and parses the
 * `info/refs?service=git-upload-pack` advertisement, then POSTs a
 * `git-upload-pack` request (wants + optional `deepen`, no haves,
 * immediate `done`, **no side-band** — so the pack follows the `NAK`
 * verbatim) and returns the raw pack bytes for the Repo DO to feed
 * through the same `ingestPack` path as a push, with the same 50 MiB cap
 * (documented v1 limit: small / depth-limited imports only).
 *
 * Network I/O goes through the Effect `HttpClient` service; callers
 * provide `FetchHttpClient.layer` (see `RepoObject.ts`'s alarm handler).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { concatBytes, isOid, ZERO_OID } from "../Protocol/ObjectCodec.ts";
import {
  flushPkt,
  pktPayloadText,
  pktText,
  readPktLineAt,
} from "../Protocol/Pkt.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Errors & shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raised when the source remote misbehaves: HTTP failures, non-200s,
 * malformed advertisements, oversize packs, or an `ERR` pkt from the
 * remote. The Repo DO maps this onto the repo's import job state.
 */
export class ImportClientError extends Schema.TaggedError<ImportClientError>()(
  "ImportClientError",
  { reason: Schema.String },
) {}

/** The import source, as accepted by `POST /api/v1/repos/import`. */
export interface ImportSource {
  /** Smart-HTTP base URL of the source repository (with or without `.git`). */
  readonly url: string;
  /** Restrict the import to a single ref (full or short name). */
  readonly ref?: string | undefined;
  /** Depth-limit the imported history (`deepen <n>`). */
  readonly depth?: number | undefined;
}

/** One ref parsed from the remote advertisement. */
export interface RemoteRef {
  readonly name: string;
  readonly oid: string;
  /** Peeled target from a `<name>^{}` line (annotated tags). */
  readonly peeled?: string | undefined;
}

/** A parsed v0 `info/refs` advertisement. */
export interface RemoteAdvertisement {
  readonly refs: ReadonlyArray<RemoteRef>;
  /**
   * The remote HEAD's symref target (e.g. `refs/heads/main`) from the
   * `symref=HEAD:...` capability, or `null` when not advertised.
   */
  readonly head: string | null;
  /** The remote's advertised capability set. */
  readonly capabilities: ReadonlySet<string>;
}

/** The result of {@link runImport}: everything the Repo DO needs to ingest. */
export interface ImportResult {
  /** The refs to create locally (already filtered by `source.ref`). */
  readonly refs: ReadonlyArray<RemoteRef>;
  /** Short default-branch name derived from the remote HEAD, or `null`. */
  readonly defaultBranch: string | null;
  /**
   * The raw pack bytes, or `undefined` when the remote is empty (nothing
   * to ingest).
   */
  readonly pack: Uint8Array | undefined;
  /** `shallow <oid>` boundary commits reported by the remote. */
  readonly shallow: ReadonlyArray<string>;
}

/** Options of {@link runImport}. */
export interface ImportOptions {
  readonly source: ImportSource;
  /**
   * Hard cap on the fetched pack size (bytes).
   * @default 52_428_800 (50 MiB, the same cap as push ingest)
   */
  readonly maxPackBytes?: number | undefined;
}

const DEFAULT_MAX_PACK = 50 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Advertisement
// ─────────────────────────────────────────────────────────────────────────────

const normalizeBase = (url: string): string => url.replace(/\/+$/, "");

/** Decodes all pkt-lines of a buffer into text/flush tokens. */
type Token =
  | { readonly _tag: "line"; readonly text: string }
  | { readonly _tag: "flush" };

const tokenize = (
  buf: Uint8Array,
): Effect.Effect<ReadonlyArray<Token>, ImportClientError> =>
  Effect.suspend(() => {
    const out: Array<Token> = [];
    let pos = 0;
    while (pos < buf.length) {
      const r = readPktLineAt(buf, pos);
      if (r._tag === "incomplete") {
        return Effect.fail(
          new ImportClientError({ reason: "truncated advertisement" }),
        );
      }
      if (r._tag === "invalid") {
        return Effect.fail(new ImportClientError({ reason: r.reason }));
      }
      if (r.pkt._tag === "flush") {
        out.push({ _tag: "flush" });
      } else if (r.pkt._tag === "data") {
        out.push({ _tag: "line", text: pktPayloadText(r.pkt.payload) });
      }
      pos = r.next;
    }
    return Effect.succeed(out);
  });

/**
 * Parses a v0 `git-upload-pack` advertisement body (including the
 * `# service=` prelude). Exposed for unit testing against fixture bytes.
 */
export const parseAdvertisement = Effect.fn(function* (body: Uint8Array) {
  const tokens = yield* tokenize(body);
  const refs: Array<RemoteRef> = [];
  const peeled = new Map<string, string>();
  let capabilities: ReadonlySet<string> = new Set();
  let head: string | null = null;
  let sawCaps = false;

  for (const token of tokens) {
    if (token._tag === "flush") continue;
    const text = token.text;
    if (text.startsWith("#")) continue; // "# service=git-upload-pack"
    if (text.startsWith("ERR ")) {
      return yield* new ImportClientError({
        reason: `remote error: ${text.slice(4)}`,
      });
    }
    let line = text;
    if (!sawCaps) {
      // First ref line carries "\0cap1 cap2 ..."
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        const caps = new Set(
          text
            .slice(nul + 1)
            .split(" ")
            .filter(Boolean),
        );
        capabilities = caps;
        for (const cap of caps) {
          if (cap.startsWith("symref=HEAD:")) {
            head = cap.slice("symref=HEAD:".length);
          }
        }
        line = text.slice(0, nul);
        sawCaps = true;
      }
    }
    const space = line.indexOf(" ");
    if (space !== 40 || !isOid(line.slice(0, 40))) continue;
    const oid = line.slice(0, 40);
    const name = line.slice(space + 1);
    if (oid === ZERO_OID && name === "capabilities^{}") {
      continue; // empty repo advertisement
    }
    if (name.endsWith("^{}")) {
      peeled.set(name.slice(0, -3), oid);
    } else {
      refs.push({ name, oid });
    }
  }

  const withPeeled = refs.map((ref) => {
    const p = peeled.get(ref.name);
    return p === undefined ? ref : { ...ref, peeled: p };
  });

  return {
    refs: withPeeled,
    head,
    capabilities,
  } satisfies RemoteAdvertisement;
});

/**
 * Fetches and parses the remote's `info/refs?service=git-upload-pack`
 * advertisement.
 */
export const fetchAdvertisement = Effect.fn(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(`${normalizeBase(url)}/info/refs?service=git-upload-pack`)
    .pipe(
      Effect.mapError(
        (error) =>
          new ImportClientError({ reason: `info/refs failed: ${error}` }),
      ),
    );
  if (response.status !== 200) {
    return yield* new ImportClientError({
      reason: `info/refs returned HTTP ${response.status}`,
    });
  }
  const body = yield* response.arrayBuffer.pipe(
    Effect.mapError(
      (error) =>
        new ImportClientError({ reason: `info/refs body read: ${error}` }),
    ),
  );
  return yield* parseAdvertisement(new Uint8Array(body));
});

// ─────────────────────────────────────────────────────────────────────────────
// upload-pack POST
// ─────────────────────────────────────────────────────────────────────────────

/** Builds the v0 upload-pack request body: wants, optional deepen, done. */
export const buildUploadPackRequest = (
  wants: ReadonlyArray<string>,
  options?: { readonly depth?: number | undefined },
): Uint8Array => {
  const parts: Array<Uint8Array> = [];
  wants.forEach((oid, index) => {
    parts.push(
      index === 0
        ? pktText(`want ${oid} ofs-delta agent=alchemy-git-service/1`)
        : pktText(`want ${oid}`),
    );
  });
  if (options?.depth !== undefined) {
    parts.push(pktText(`deepen ${options.depth}`));
  }
  parts.push(flushPkt);
  parts.push(pktText("done"));
  return concatBytes(parts);
};

/**
 * The parsed upload-pack response: the shallow boundary lines (when a
 * `deepen` was requested) and the raw pack bytes that follow the `NAK`.
 */
export interface UploadPackResponse {
  readonly shallow: ReadonlyArray<string>;
  readonly pack: Uint8Array;
}

/**
 * Splits a (non-side-band) upload-pack response into its shallow section /
 * NAK and the trailing raw pack. Exposed for unit testing.
 */
export const parseUploadPackResponse = Effect.fn(function* (body: Uint8Array) {
  const shallow: Array<string> = [];
  let pos = 0;
  for (;;) {
    if (pos >= body.length) {
      return yield* new ImportClientError({
        reason: "upload-pack response ended before NAK/ACK",
      });
    }
    const r = readPktLineAt(body, pos);
    if (r._tag === "incomplete" || r._tag === "invalid") {
      return yield* new ImportClientError({
        reason:
          r._tag === "invalid" ? r.reason : "truncated upload-pack response",
      });
    }
    pos = r.next;
    if (r.pkt._tag !== "data") continue; // flush after the shallow section
    const text = pktPayloadText(r.pkt.payload);
    if (text.startsWith("shallow ")) {
      const oid = text.slice("shallow ".length);
      if (isOid(oid)) shallow.push(oid);
      continue;
    }
    if (text.startsWith("unshallow ")) continue;
    if (text.startsWith("ERR ")) {
      return yield* new ImportClientError({
        reason: `remote error: ${text.slice(4)}`,
      });
    }
    if (text === "NAK" || text.startsWith("ACK ")) {
      // Pack bytes follow verbatim (no side-band was requested).
      return {
        shallow,
        pack: body.subarray(pos),
      } satisfies UploadPackResponse;
    }
    // Ignore anything else (progress from misbehaving servers).
  }
});

/**
 * POSTs the upload-pack request and returns the shallow lines + raw pack.
 */
export const fetchPack = Effect.fn(function* (
  url: string,
  wants: ReadonlyArray<string>,
  options?: {
    readonly depth?: number | undefined;
    readonly maxPackBytes?: number | undefined;
  },
) {
  const client = yield* HttpClient.HttpClient;
  const maxPack = options?.maxPackBytes ?? DEFAULT_MAX_PACK;
  const request = HttpClientRequest.post(
    `${normalizeBase(url)}/git-upload-pack`,
  ).pipe(
    HttpClientRequest.setHeaders({
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
    }),
    HttpClientRequest.bodyUint8Array(
      buildUploadPackRequest(wants, { depth: options?.depth }),
    ),
  );
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.mapError(
        (error) =>
          new ImportClientError({ reason: `git-upload-pack failed: ${error}` }),
      ),
    );
  if (response.status !== 200) {
    return yield* new ImportClientError({
      reason: `git-upload-pack returned HTTP ${response.status}`,
    });
  }
  const body = yield* response.arrayBuffer.pipe(
    Effect.mapError(
      (error) =>
        new ImportClientError({
          reason: `git-upload-pack body read: ${error}`,
        }),
    ),
  );
  if (body.byteLength > maxPack + 65536) {
    return yield* new ImportClientError({
      reason: `source pack exceeds the ${maxPack} byte import cap`,
    });
  }
  const parsed = yield* parseUploadPackResponse(new Uint8Array(body));
  if (parsed.pack.byteLength > maxPack) {
    return yield* new ImportClientError({
      reason: `source pack exceeds the ${maxPack} byte import cap`,
    });
  }
  return parsed;
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves `source.ref` (full or short name) against advertised refs. */
const selectRefs = (
  advertised: ReadonlyArray<RemoteRef>,
  ref: string | undefined,
): ReadonlyArray<RemoteRef> | undefined => {
  if (ref === undefined) {
    return advertised.filter(
      (r) =>
        r.name.startsWith("refs/heads/") || r.name.startsWith("refs/tags/"),
    );
  }
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  const match = advertised.find((r) => candidates.includes(r.name));
  return match === undefined ? undefined : [match];
};

/**
 * Runs the full import client flow: advertisement → ref selection →
 * upload-pack POST. Returns everything the Repo DO's alarm job needs to
 * ingest the history and create the refs. Requires `HttpClient.HttpClient`
 * (provide `FetchHttpClient.layer`).
 */
export const runImport = Effect.fn(function* (options: ImportOptions) {
  const { source } = options;
  const advertisement = yield* fetchAdvertisement(source.url);

  const selected = selectRefs(advertisement.refs, source.ref);
  if (selected === undefined) {
    return yield* new ImportClientError({
      reason: `ref '${source.ref}' not found on the remote`,
    });
  }

  const defaultBranch =
    advertisement.head !== null && advertisement.head.startsWith("refs/heads/")
      ? advertisement.head.slice("refs/heads/".length)
      : null;

  if (selected.length === 0) {
    // Empty remote — nothing to fetch.
    return {
      refs: [],
      defaultBranch,
      pack: undefined,
      shallow: [],
    } satisfies ImportResult;
  }

  // Want the peeled targets too? No — wanting the tag object oid pulls the
  // whole chain; peeled lines are advisory.
  const wants = Array.from(new Set(selected.map((r) => r.oid)));
  const { shallow, pack } = yield* fetchPack(source.url, wants, {
    depth: source.depth,
    maxPackBytes: options.maxPackBytes,
  });

  return {
    refs: selected,
    defaultBranch,
    pack,
    shallow,
  } satisfies ImportResult;
});
