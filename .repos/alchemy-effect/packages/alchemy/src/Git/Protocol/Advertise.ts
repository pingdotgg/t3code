/**
 * Protocol-v0 ref advertisement builders (DESIGN §2.3, §4).
 *
 * The smart-HTTP advertisement body is two pkt-line streams:
 *
 * ```
 * 001e# service=git-upload-pack\n
 * 0000
 * <oid> HEAD\0<capabilities>\n         ← first ref carries caps after a NUL
 * <oid> refs/heads/main\n
 * <oid> refs/tags/v1\n
 * <peeled> refs/tags/v1^{}\n           ← annotated tags peeled
 * 0000
 * ```
 *
 * Empty repo: a single `<zero-id> capabilities^{}\0<caps>` line. The response
 * must carry `Content-Type: application/x-git-{service}-advertisement` and
 * `Cache-Control: no-cache` (the client validates the first five bytes match
 * `^[0-9a-f]{4}#`).
 */
import { concatBytes, utf8Encode, ZERO_OID } from "./ObjectCodec.ts";
import { flushPkt, pktLine } from "./Pkt.ts";
import type { RefRecord, RefsSnapshot } from "./Store.ts";

/** The agent string advertised by both services. */
export const AGENT = "git-service/1";

/** The two smart-HTTP services. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/**
 * The v0 upload-pack capability set (DESIGN §2.3): stateless
 * `multi_ack_detailed` + `no-done` negotiation, side-band-64k muxing, shallow
 * (`deepen <n>` only), and the default-branch symref.
 */
export const uploadPackCapabilities = (defaultBranch: string): string =>
  `multi_ack_detailed no-done side-band-64k shallow ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${defaultBranch} object-format=sha1`;

/**
 * The v0 receive-pack capability set (DESIGN §2.3): per-ref report-status
 * (v1 and v2 — v2 is implemented identically, with no `option` lines, which
 * is valid), ref deletion, atomic pushes, and OFS_DELTA in pushed packs.
 */
export const receivePackCapabilities = (): string =>
  `report-status report-status-v2 delete-refs side-band-64k atomic ofs-delta object-format=sha1 agent=${AGENT}`;

/**
 * The `Content-Type` of a `GET info/refs?service=` advertisement response.
 */
export const advertisementContentType = (service: GitService): string =>
  `application/x-${service}-advertisement`;

/**
 * The `Content-Type` of a `POST /git-{upload,receive}-pack` result response.
 */
export const resultContentType = (service: GitService): string =>
  `application/x-${service}-result`;

/**
 * Builds the `# service=` prelude: one pkt-line plus a flush. Sent before the
 * ref list on `info/refs` for both services.
 */
export const servicePrelude = (service: GitService): Uint8Array =>
  concatBytes([pktLine(utf8Encode(`# service=${service}\n`)), flushPkt]);

/** One advertised `<oid> <name>` record (already flattened, incl. `^{}`). */
interface AdvertisedRecord {
  readonly oid: string;
  readonly name: string;
}

const flattenRefs = (
  refs: ReadonlyArray<RefRecord>,
): Array<AdvertisedRecord> => {
  const sorted = [...refs].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const records: Array<AdvertisedRecord> = [];
  for (const ref of sorted) {
    records.push({ oid: ref.oid, name: ref.name });
    if (ref.peeled !== undefined) {
      records.push({ oid: ref.peeled, name: `${ref.name}^{}` });
    }
  }
  return records;
};

/**
 * Encodes the ref list section: first record carries the capability list
 * after a NUL; an empty list becomes the zero-id `capabilities^{}` line;
 * terminated by a flush.
 */
const refListSection = (
  records: ReadonlyArray<AdvertisedRecord>,
  capabilities: string,
): Uint8Array => {
  const lines: Array<Uint8Array> = [];
  if (records.length === 0) {
    lines.push(
      pktLine(utf8Encode(`${ZERO_OID} capabilities^{}\0${capabilities}\n`)),
    );
  } else {
    const first = records[0]!;
    lines.push(
      pktLine(utf8Encode(`${first.oid} ${first.name}\0${capabilities}\n`)),
    );
    for (let i = 1; i < records.length; i++) {
      const record = records[i]!;
      lines.push(pktLine(utf8Encode(`${record.oid} ${record.name}\n`)));
    }
  }
  lines.push(flushPkt);
  return concatBytes(lines);
};

/**
 * Builds the complete `info/refs?service=git-upload-pack` advertisement body:
 * prelude, then `HEAD` first (its oid = the default branch tip, when that
 * branch exists) with the capability line, then refs sorted by name with
 * peeled `^{}` lines for annotated tags. An empty repo advertises the
 * zero-id `capabilities^{}` form.
 */
export const uploadPackAdvertisement = (snapshot: RefsSnapshot): Uint8Array => {
  const records = flattenRefs(snapshot.refs);
  const head = snapshot.refs.find(
    (ref) => ref.name === `refs/heads/${snapshot.defaultBranch}`,
  );
  const withHead =
    head === undefined
      ? records
      : [{ oid: head.oid, name: "HEAD" }, ...records];
  return concatBytes([
    servicePrelude("git-upload-pack"),
    refListSection(withHead, uploadPackCapabilities(snapshot.defaultBranch)),
  ]);
};

/**
 * Builds the complete `info/refs?service=git-receive-pack` advertisement
 * body. `HEAD` is not advertised (it is not pushable); refs are sorted with
 * peeled lines; an empty repo advertises the zero-id `capabilities^{}` form
 * (which is how the first-ever push learns the capability set).
 */
export const receivePackAdvertisement = (snapshot: RefsSnapshot): Uint8Array =>
  concatBytes([
    servicePrelude("git-receive-pack"),
    refListSection(flattenRefs(snapshot.refs), receivePackCapabilities()),
  ]);

/**
 * Builds the advertisement for either service.
 */
export const advertisement = (
  service: GitService,
  snapshot: RefsSnapshot,
): Uint8Array =>
  service === "git-upload-pack"
    ? uploadPackAdvertisement(snapshot)
    : receivePackAdvertisement(snapshot);
