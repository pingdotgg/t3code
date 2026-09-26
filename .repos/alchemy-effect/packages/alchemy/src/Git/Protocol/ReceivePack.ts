/**
 * Protocol-v0 push choreography (DESIGN §2.3, §3.6, §4) as pure functions.
 *
 * Request shape (`POST /git-receive-pack`):
 *
 * ```
 * *PKT-LINE("shallow" SP obj-id)                          ; shallow clients
 * PKT-LINE(old-oid SP new-oid SP refname NUL cap-list LF) ; first command
 * *PKT-LINE(old-oid SP new-oid SP refname LF)
 * flush-pkt
 * [raw PACK bytes]                                        ; NOT pkt-line framed
 * ```
 *
 * The pack follows the flush as raw bytes and is present iff any
 * create/update command exists (it may be an empty 0-object pack); it is
 * absent for delete-only pushes. Clients push **thin packs** over HTTP by
 * default — REF_DELTA bases resolve from the object store during ingest.
 *
 * The **empty-flush probe**: git sends a bare `0000` POST when the payload
 * exceeds `http.postBuffer`; the server replies with an empty 200 so the
 * client retries with the real body.
 *
 * The choreography splits so the Repo DO owns the transaction:
 * {@link parseReceivePackRequest} → {@link ingestPushPack} (staging sink) →
 * {@link checkConnectivity} → DO `transactionSync` CAS →
 * {@link reportStatus}.
 */
import * as Effect from "effect/Effect";
import {
  concatBytes,
  isOid,
  ObjectParseError,
  type ObjectType,
  type Oid,
  parseCommit,
  parseTag,
  parseTree,
  treeEntryKind,
  ZERO_OID,
} from "./ObjectCodec.ts";
import {
  bufferRandomAccess,
  ingestPack,
  type IngestSummary,
  type PackIngestError,
  type ResolvedEntry,
  type ThinBaseSource,
} from "./PackParser.ts";
import {
  flushPkt,
  PktLineError,
  pktPayloadText,
  pktText,
  ProtocolError,
  readPktLineAt,
} from "./Pkt.ts";
import { sidebandFrames } from "./Sideband.ts";
import { StoreError } from "./Store.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One ref update command: `old-oid SP new-oid SP refname`. `old-oid` is the
 * client's expectation and the CAS token; zero-id old ⇒ create, zero-id new
 * ⇒ delete.
 */
export interface RefCommand {
  readonly oldOid: Oid;
  readonly newOid: Oid;
  readonly ref: string;
}

/** The kind of a ref command derived from its zero-id sides. */
export type CommandKind = "create" | "update" | "delete";

/**
 * Classifies a command: zero old-oid ⇒ `create`, zero new-oid ⇒ `delete`,
 * else `update`.
 */
export const commandKind = (command: RefCommand): CommandKind =>
  command.oldOid === ZERO_OID
    ? "create"
    : command.newOid === ZERO_OID
      ? "delete"
      : "update";

/**
 * A parsed `git-receive-pack` request.
 */
export interface ReceivePackRequest {
  /** Ref update commands, in request order. */
  readonly commands: ReadonlyArray<RefCommand>;
  /** Capabilities chosen by the client (after the NUL on the first command). */
  readonly capabilities: ReadonlySet<string>;
  /** `shallow` lines from shallow clients (v1: parsed, not honored). */
  readonly shallow: ReadonlyArray<Oid>;
  /** Byte offset of the raw pack in the body (position after the flush). */
  readonly packOffset: number;
  /** Whether raw pack bytes follow the flush. */
  readonly hasPack: boolean;
  /** `atomic` requested: all-or-nothing ref updates. */
  readonly atomic: boolean;
  /** `side-band-64k` requested: the report must be muxed on band 1. */
  readonly sideband: boolean;
  /** `report-status` or `report-status-v2` requested. */
  readonly reportStatus: boolean;
}

/**
 * The outcome of parsing a receive-pack body: the empty-flush probe (reply
 * with an empty 200) or a real request.
 */
export type ParsedReceivePack =
  | { readonly _tag: "probe" }
  | { readonly _tag: "request"; readonly request: ReceivePackRequest };

// control chars, space, DEL, and git's forbidden refname metacharacters
const REFNAME_FORBIDDEN = new RegExp("[\\x00-\\x20\\x7f\\\\~^:?*\\[]");

const validRefName = (name: string): boolean =>
  name.startsWith("refs/") &&
  name.length > "refs/".length &&
  !name.endsWith("/") &&
  !name.includes("..") &&
  !name.endsWith(".lock") &&
  !REFNAME_FORBIDDEN.test(name);

const parseCommandLine = (
  line: string,
): Effect.Effect<RefCommand, ProtocolError> =>
  Effect.suspend(() => {
    const oldOid = line.slice(0, 40);
    const newOid = line.slice(41, 81);
    const ref = line.slice(82);
    if (
      !isOid(oldOid) ||
      line[40] !== " " ||
      !isOid(newOid) ||
      line[81] !== " " ||
      ref.length === 0
    ) {
      return Effect.fail(
        new ProtocolError({ reason: `malformed command line: ${line}` }),
      );
    }
    if (!validRefName(ref)) {
      return Effect.fail(
        new ProtocolError({ reason: `invalid refname: ${ref}` }),
      );
    }
    if (oldOid === ZERO_OID && newOid === ZERO_OID) {
      return Effect.fail(
        new ProtocolError({ reason: `zero-to-zero command for ${ref}` }),
      );
    }
    return Effect.succeed({ oldOid, newOid, ref });
  });

/**
 * Parses a `git-receive-pack` request body (already gunzipped): shallow
 * lines, the command list (NUL-separated caps on the first command), the
 * flush, and the position of the raw pack payload. A body containing no
 * commands is the **empty-flush probe**.
 */
export const parseReceivePackRequest = Effect.fn(function* (body: Uint8Array) {
  const commands: Array<RefCommand> = [];
  const capabilities = new Set<string>();
  const shallow: Array<Oid> = [];
  let pos = 0;

  for (;;) {
    const result = readPktLineAt(body, pos);
    if (result._tag === "incomplete") {
      return yield* new PktLineError({
        reason: `truncated receive-pack request at offset ${pos}`,
      });
    }
    if (result._tag === "invalid") {
      return yield* new PktLineError({ reason: result.reason });
    }
    const pkt = result.pkt;
    if (pkt._tag === "flush") {
      pos = result.next;
      break;
    }
    if (pkt._tag !== "data") {
      return yield* new ProtocolError({
        reason: `unexpected ${pkt._tag} packet in receive-pack request`,
      });
    }
    const text = pktPayloadText(pkt.payload);
    if (text.startsWith("shallow ")) {
      const oid = text.slice(8);
      if (!isOid(oid)) {
        return yield* new ProtocolError({
          reason: `malformed shallow line: ${text}`,
        });
      }
      shallow.push(oid);
    } else {
      const nul = text.indexOf("\0");
      const line = nul === -1 ? text : text.slice(0, nul);
      if (nul !== -1) {
        for (const cap of text.slice(nul + 1).split(" ")) {
          if (cap.length > 0) capabilities.add(cap);
        }
      }
      commands.push(yield* parseCommandLine(line));
    }
    pos = result.next;
  }

  if (commands.length === 0) {
    return { _tag: "probe" } as ParsedReceivePack;
  }

  const request: ReceivePackRequest = {
    commands,
    capabilities,
    shallow,
    packOffset: pos,
    hasPack: pos < body.length,
    atomic: capabilities.has("atomic"),
    sideband: capabilities.has("side-band-64k"),
    reportStatus:
      capabilities.has("report-status") || capabilities.has("report-status-v2"),
  };
  return { _tag: "request", request } as ParsedReceivePack;
});

// ─────────────────────────────────────────────────────────────────────────────
// Ingest driver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for {@link ingestPushPack}.
 */
export interface IngestPushOptions<E, R> {
  /** The full (gunzipped, buffered) request body. */
  readonly body: Uint8Array;
  /** `request.packOffset` from {@link parseReceivePackRequest}. */
  readonly packOffset: number;
  /** Live objects — resolves thin REF_DELTA bases. */
  readonly store: ThinBaseSource;
  /** Receives each resolved entry (the DO stages it under the push id). */
  readonly sink: (entry: ResolvedEntry) => Effect.Effect<void, E, R>;
  /** Per-object uncompressed cap; defaults to the parser's 64 MiB. */
  readonly maxObjectSize?: number | undefined;
}

/**
 * Drives {@link ingestPack} over the pack payload of a push body. A
 * delete-only push (no pack bytes) yields an empty summary without touching
 * the parser.
 */
export const ingestPushPack = <E, R>(
  options: IngestPushOptions<E, R>,
): Effect.Effect<IngestSummary, PackIngestError | E, R> =>
  options.packOffset >= options.body.length
    ? Effect.succeed({ count: 0, oids: [] })
    : ingestPack({
        source: bufferRandomAccess(options.body.subarray(options.packOffset)),
        store: options.store,
        sink: options.sink,
        maxObjectSize: options.maxObjectSize,
      });

// ─────────────────────────────────────────────────────────────────────────────
// Connectivity check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A staged object's identity, as needed by the connectivity walk.
 */
export interface StagedObjectRef {
  readonly oid: Oid;
  readonly type: ObjectType;
}

/**
 * The membership oracle and content reader the connectivity check needs —
 * implemented by the Repo DO over batched SQL.
 */
export interface ConnectivityDeps {
  /** Reads a staged object's inflated content. */
  readonly readStagedContent: (
    oid: Oid,
  ) => Effect.Effect<Uint8Array, StoreError>;
  /**
   * Filters oids down to those existing among **live** objects (batched,
   * chunked `IN` lists; order not guaranteed).
   */
  readonly filterLiveExisting: (
    oids: ReadonlyArray<Oid>,
  ) => Effect.Effect<ReadonlyArray<Oid>, StoreError>;
}

/**
 * The full connectivity check (DESIGN §3.6 step 5): collects every oid
 * referenced by staged commits (tree, parents), staged trees (entries —
 * gitlinks excluded, they point outside the repo), staged tags (target),
 * plus every command's non-zero `new-oid`; then verifies membership against
 * staged ∪ live objects. Returns the missing oids (empty = connected).
 *
 * This is the difference between "corrupt client" and "corrupt repo": any
 * miss fails the push with `unpack missing objects` + all-`ng`.
 */
export const checkConnectivity = Effect.fn(function* (
  staged: ReadonlyArray<StagedObjectRef>,
  commandNewOids: ReadonlyArray<Oid>,
  deps: ConnectivityDeps,
) {
  const stagedSet = new Set(staged.map((s) => s.oid));
  const referenced = new Set<Oid>();

  for (const object of staged) {
    switch (object.type) {
      case 1: {
        const content = yield* deps.readStagedContent(object.oid);
        const commit = yield* parseCommit(content);
        referenced.add(commit.tree);
        for (const parent of commit.parents) referenced.add(parent);
        break;
      }
      case 2: {
        const content = yield* deps.readStagedContent(object.oid);
        const entries = yield* parseTree(content);
        for (const entry of entries) {
          // gitlinks (mode 160000) reference commits in other repos — skip
          if (treeEntryKind(entry.mode) !== "commit") {
            referenced.add(entry.oid);
          }
        }
        break;
      }
      case 4: {
        const content = yield* deps.readStagedContent(object.oid);
        const tag = yield* parseTag(content);
        referenced.add(tag.object);
        break;
      }
      default:
        break; // blobs reference nothing
    }
  }
  for (const oid of commandNewOids) {
    if (oid !== ZERO_OID) referenced.add(oid);
  }

  const candidates = [...referenced].filter((oid) => !stagedSet.has(oid));
  if (candidates.length === 0) return [] as ReadonlyArray<Oid>;
  const live = new Set(yield* deps.filterLiveExisting(candidates));
  return candidates.filter((oid) => !live.has(oid)).sort();
});

// ─────────────────────────────────────────────────────────────────────────────
// report-status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-ref outcome of the CAS transaction, produced by the Repo DO and
 * rendered by {@link reportStatus}.
 */
export interface CommandResult {
  readonly ref: string;
  readonly ok: boolean;
  /** Failure reason for `ng` lines (e.g. `fetch first`). */
  readonly reason?: string | undefined;
}

/** Builds an `ok <ref>` result. */
export const okResult = (ref: string): CommandResult => ({ ref, ok: true });

/** Builds an `ng <ref> <reason>` result. */
export const ngResult = (ref: string, reason: string): CommandResult => ({
  ref,
  ok: false,
  reason,
});

/**
 * Options for {@link reportStatus}.
 */
export interface ReportStatusOptions {
  /** `"ok"` when the pack ingested cleanly, else the unpack error message. */
  readonly unpack: string;
  /** Per-ref results in command order. */
  readonly results: ReadonlyArray<CommandResult>;
  /** Wrap the report in side-band band 1 (mandatory when negotiated). */
  readonly sideband: boolean;
}

/**
 * Renders the `report-status` (and `report-status-v2` — implemented
 * identically, with no `option` lines, which is valid) response:
 *
 * ```
 * unpack ok|<error>
 * ok <ref> | ng <ref> <reason>   (per command)
 * flush
 * ```
 *
 * When the client negotiated `side-band-64k` the entire report (including
 * its flush) is wrapped in band-1 frames followed by the outer flush —
 * sending it unmuxed while side-band is active breaks the client.
 */
export const reportStatus = (options: ReportStatusOptions): Uint8Array => {
  const inner = concatBytes([
    pktText(`unpack ${options.unpack}`),
    ...options.results.map((result) =>
      pktText(
        result.ok
          ? `ok ${result.ref}`
          : `ng ${result.ref} ${result.reason ?? "failed"}`,
      ),
    ),
    flushPkt,
  ]);
  return options.sideband
    ? concatBytes([...sidebandFrames(1, inner), flushPkt])
    : inner;
};

/**
 * Renders the all-failed report used for whole-push rejections: pack too
 * large, checksum mismatch, missing objects, read-only repo. `unpack` carries
 * the reason and every command gets an `ng` with the same reason.
 */
export const failAllReport = (
  commands: ReadonlyArray<RefCommand>,
  reason: string,
  sideband: boolean,
): Uint8Array =>
  reportStatus({
    unpack: reason,
    results: commands.map((command) => ngResult(command.ref, reason)),
    sideband,
  });

/** Errors the parse phase of receive-pack can produce. */
export type ReceivePackParseError = PktLineError | ProtocolError;

/** Errors the connectivity check can produce. */
export type ConnectivityError = StoreError | ObjectParseError;
