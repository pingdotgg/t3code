// @effect-diagnostics nodeBuiltinImport:off globalDate:off - this isolated worker runs outside the Effect runtime and uses synchronous Node APIs for bounded file hashing and SDK path handling.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type {
  CodeGraph as CodeGraphInstance,
  Edge,
  IndexProgress,
  Language,
  Node as CodeGraphNode,
  SearchResult,
  UnresolvedReference,
} from "@colbymchenry/codegraph";
import { isLikelyTestPath } from "@t3tools/shared/testPaths";
import type {
  ProjectCodeCoverage,
  ProjectCodeEdge,
  ProjectCodeFile,
  ProjectCodeIndexInfo,
  ProjectCodeSymbolGroup,
  ProjectCodeMatch,
  ProjectCodePathSearch,
  ProjectCodeQuery,
  ProjectCodeQueryResult,
  ProjectCodeSelection,
  ProjectCodeSourceDigest,
  ProjectCodeStats,
  ProjectCodeSymbol,
  ProjectCodeSymbolSelector,
  ProjectCodeUnresolvedReference,
} from "@t3tools/contracts";

import {
  CHECKOUT_CONFIG_ENTRIES,
  clearCheckoutSources,
  linkCheckoutSources,
} from "./codeIndexLayout.ts";

const CATALOG_REVISION = "@colbymchenry/codegraph@1.6.2";
// Programming languages outside the SDK's catalog, which it reports as unknown like any asset.
const UNREADABLE_SOURCE = /\.(?:clj|cljs|cr|elm|ex|exs|fs|fsx|gd|hs|jl|ml|mli|nim|pl|pm|rkt|zig)$/i;
const MAX_RESULTS = 200;
const MAX_FILES_FOR_UNRESOLVED = 50;
const MAX_LISTED_FILES = 10_000;
const INDEX_META_FILE = "t3-index.json";
// The database and its write-ahead log; a successor generation starts from copies of both.
const INDEX_DATABASE_FILES = ["codegraph.db", "codegraph.db-wal"];
// A test or path walk stops after this many visited symbols, whatever the depth.
const MAX_WALK_NODES = 2_000;
const DEFAULT_PATH_DEPTH = 6;
const MAX_AFFECTED_SYMBOLS = 20;
const AFFECTED_CALLERS_PER_SYMBOL = 8;
const AFFECTED_TESTS_PER_SYMBOL = 5;

interface CodeGraphModule {
  readonly CodeGraph: {
    isInitialized(root: string): boolean;
    init(root: string, options: { index: false }): Promise<CodeGraphInstance>;
    open(root: string, options: { sync: false; readOnly?: boolean }): Promise<CodeGraphInstance>;
    recreate(root: string): Promise<CodeGraphInstance>;
  };
  readonly getSupportedLanguages: () => Language[];
  readonly detectLanguage: (path: string) => Language;
}

interface CheckoutListing {
  readonly checkoutPath: string;
  // The SDK's project root: it holds the index and links back to the checkout's sources.
  readonly indexRoot: string;
  readonly files: ReadonlyArray<string>;
  readonly filesListed: number;
  readonly listingTruncated: boolean;
}

export interface CodeIntelligenceWorkerInput extends CheckoutListing {
  readonly query: ProjectCodeQuery;
  // The published generation's directory, or null when the checkout has none yet.
  readonly indexDirectory: string | null;
}

export interface CodeIndexBuildInput extends CheckoutListing {
  // The published generation the build starts from, or null to index from scratch.
  readonly from: string | null;
  readonly to: string;
  readonly generation: number;
}

function sdk(): CodeGraphModule {
  return NodeModule.createRequire(import.meta.url)("@colbymchenry/codegraph") as CodeGraphModule;
}

/**
 * The SDK resolves its data directory from CODEGRAPH_DIR on every call, and a worker thread has
 * its own copy of the environment, so this selects the generation for the calls that follow.
 */
function useIndexDirectory(name: string): void {
  process.env.CODEGRAPH_DIR = name;
}

function mapSymbol(node: CodeGraphNode): ProjectCodeSymbol {
  return {
    id: node.id.slice(0, 2048),
    name: node.name.slice(0, 512),
    qualifiedName: node.qualifiedName.slice(0, 2048),
    kind: node.kind.slice(0, 512),
    language: node.language.slice(0, 512),
    path: node.filePath.slice(0, 2048),
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    signature: node.signature?.slice(0, 2048) ?? null,
    isExported: node.isExported ?? false,
  };
}

function mapEdge(
  edge: Edge,
  graph: CodeGraphInstance,
  allowedPaths: ReadonlySet<string>,
): ProjectCodeEdge {
  const confidence = edge.metadata?.confidence;
  const resolvedBy = edge.metadata?.resolvedBy;
  const referenceName = edge.metadata?.refName;
  const alsoTargets = edge.metadata?.alsoTargets;
  return {
    source: edge.source.slice(0, 2048),
    target: edge.target.slice(0, 2048),
    kind: edge.kind.slice(0, 512),
    confidence: typeof confidence === "number" ? confidence : null,
    resolvedBy: typeof resolvedBy === "string" ? resolvedBy.slice(0, 512) : null,
    provenance: edge.provenance ?? null,
    evidenceGrade:
      edge.provenance === "scip"
        ? "compiler-indexed"
        : edge.provenance === "heuristic"
          ? "heuristic-candidate"
          : "static-candidate",
    line: edge.line ?? null,
    column: edge.column ?? null,
    referenceName: typeof referenceName === "string" ? referenceName.slice(0, 512) : null,
    candidateTargets: Array.isArray(alsoTargets)
      ? alsoTargets
          .flatMap((target) => {
            if (typeof target !== "object" || target === null) return [];
            const id = (target as { readonly targetNodeId?: unknown }).targetNodeId;
            if (typeof id !== "string") return [];
            const node = graph.getNode(id);
            return node !== null && allowedPaths.has(node.filePath) ? [id.slice(0, 2048)] : [];
          })
          .slice(0, 20)
      : [],
  };
}

function mapMatch(result: SearchResult): ProjectCodeMatch {
  return {
    symbol: mapSymbol(result.node),
    score: result.score,
    highlights: (result.highlights ?? []).slice(0, 16).map((highlight) => highlight.slice(0, 2048)),
  };
}

function mapUnresolved(
  reference: UnresolvedReference,
  graph: CodeGraphInstance,
  allowedPaths: ReadonlySet<string>,
): ProjectCodeUnresolvedReference {
  return {
    from: reference.fromNodeId.slice(0, 2048),
    name: reference.referenceName.slice(0, 512),
    kind: reference.referenceKind.slice(0, 512),
    filePath: (reference.filePath ?? "").slice(0, 2048),
    language: reference.language?.slice(0, 512) ?? null,
    line: reference.line,
    column: reference.column,
    candidates: (reference.candidates ?? [])
      .filter((candidate) => {
        const node = graph.getNode(candidate);
        return node !== null && allowedPaths.has(node.filePath);
      })
      .slice(0, 20)
      .map((candidate) => candidate.slice(0, 2048)),
  };
}

function safeRelativePath(checkoutPath: string, filePath: string): string | null {
  const resolved = NodePath.resolve(checkoutPath, filePath);
  const relative = NodePath.relative(checkoutPath, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    return null;
  return relative.split(NodePath.sep).join("/");
}

function authorizedSourcePath(checkoutPath: string, filePath: string): string | null {
  const relativePath = safeRelativePath(checkoutPath, filePath);
  if (relativePath === null) return null;
  try {
    const root = NodeFS.realpathSync(checkoutPath);
    const source = NodeFS.realpathSync(NodePath.resolve(root, relativePath));
    const relative = NodePath.relative(root, source);
    return relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
      ? null
      : relativePath;
  } catch {
    return null;
  }
}

interface IndexMeta {
  readonly commit: string | null;
  readonly generation: number;
  readonly indexedAt: number | null;
  // Listed sources the build deliberately left out, such as build output: coverage gaps, not
  // newly added files a refresh would pick up.
  readonly skippedPaths: ReadonlyArray<string>;
  // Whether the build ranked an over-cap listing; older builds kept whatever sorted first.
  readonly ranked: boolean;
  readonly configurationDigest: string | null;
}

function readIndexMeta(indexRoot: string, indexDirectory: string): IndexMeta {
  try {
    const raw: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(indexRoot, indexDirectory, INDEX_META_FILE), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) throw new Error("invalid");
    const { commit, generation, indexedAt, skippedPaths, ranked, configurationDigest } =
      raw as Record<string, unknown>;
    return {
      ranked: ranked === true,
      configurationDigest:
        typeof configurationDigest === "string" && /^[0-9a-f]{64}$/.test(configurationDigest)
          ? configurationDigest
          : null,
      commit: typeof commit === "string" && /^[0-9a-f]{7,64}$/.test(commit) ? commit : null,
      generation:
        typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
          ? generation
          : 0,
      indexedAt: typeof indexedAt === "number" && Number.isFinite(indexedAt) ? indexedAt : null,
      skippedPaths:
        Array.isArray(skippedPaths) &&
        skippedPaths.length <= MAX_LISTED_FILES &&
        skippedPaths.every((path): path is string => typeof path === "string")
          ? skippedPaths
          : [],
    };
  } catch {
    return {
      commit: null,
      generation: 0,
      indexedAt: null,
      skippedPaths: [],
      ranked: false,
      configurationDigest: null,
    };
  }
}

function checkoutConfigurationDigest(checkoutPath: string): string {
  const digest = NodeCrypto.createHash("sha256");
  for (const name of CHECKOUT_CONFIG_ENTRIES) {
    digest.update(name).update("\0");
    try {
      const contents = NodeFS.readFileSync(NodePath.join(checkoutPath, name));
      digest.update("present\0").update(contents);
    } catch (cause) {
      // Anything unreadable, such as a folder of that name, configures nothing.
      digest.update(
        (cause as NodeJS.ErrnoException).code === "ENOENT" ? "missing\0" : "unreadable\0",
      );
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

function writeIndexMeta(indexRoot: string, indexDirectory: string, meta: IndexMeta): void {
  const target = NodePath.join(indexRoot, indexDirectory, INDEX_META_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    // An exclusive create never follows a planted link, and the rename replaces the entry
    // rather than writing through whatever it pointed at.
    NodeFS.writeFileSync(temporary, JSON.stringify(meta), { flag: "wx" });
    NodeFS.renameSync(temporary, target);
  } catch {
    NodeFS.rmSync(temporary, { force: true });
    // The marker only labels freshness; an unwritable one reads back as an unknown commit.
  }
}

// The worker owns its thread, so a short synchronous git call blocks nothing else.
function headCommit(checkoutPath: string): string | null {
  try {
    const output = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      {
        cwd: checkoutPath,
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return /^[0-9a-f]{7,64}$/.test(output) ? output : null;
  } catch {
    return null;
  }
}

// Mirrors the SDK's file limit: it never parses a larger file and stores a hash of a size
// stamp in place of its content.
const MAX_SOURCE_FILE_SIZE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const sha256 = (input: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(input).digest("hex");

/** A source's bytes when within the SDK's limit, `null` over it; never reads past limit + 1. */
function readBoundedSource(descriptor: number): {
  readonly size: number;
  readonly bytes: Buffer | null;
} {
  const stats = NodeFS.fstatSync(descriptor);
  if (!stats.isFile()) throw new Error("not a regular file");
  if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { size: stats.size, bytes: null };
  const chunks: Buffer[] = [];
  let size = 0;
  while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
    const chunk = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size),
    );
    const read = NodeFS.readSync(descriptor, chunk, 0, chunk.length, size);
    if (read === 0) break;
    chunks.push(chunk.subarray(0, read));
    size += read;
  }
  return size > MAX_SOURCE_FILE_SIZE_BYTES
    ? { size, bytes: null }
    : { size, bytes: Buffer.concat(chunks, size) };
}

/** The hash the index stores for these contents: of the decoded text, or of the size stamp. */
function indexedContentHash(source: ReturnType<typeof readBoundedSource>): string {
  return sha256(
    source.bytes === null ? `codegraph:oversize:${source.size}` : source.bytes.toString("utf8"),
  );
}

function indexedContentHashOfFile(path: string): string | null {
  try {
    const descriptor = NodeFS.openSync(path, "r");
    try {
      return indexedContentHash(readBoundedSource(descriptor));
    } finally {
      NodeFS.closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

/**
 * Listed source files whose bytes no longer match the index, plus supported files the index
 * has never seen. Size and mtime screen out unchanged files so only candidates are hashed.
 */
function changedSinceIndex(
  checkoutPath: string,
  graph: CodeGraphInstance,
  listedPaths: ReadonlyArray<string>,
  isSupported: (path: string) => boolean,
  skippedPaths: ReadonlyArray<string>,
): string[] {
  const listed = new Set(listedPaths);
  const skipped = new Set(skippedPaths);
  const indexed = new Map(graph.getFiles().map((file) => [file.path, file]));
  const changed: string[] = [];
  for (const path of listedPaths) {
    const record = indexed.get(path);
    const absolute = NodePath.resolve(checkoutPath, path);
    if (record === undefined) {
      if (isSupported(path) && !skipped.has(path)) changed.push(path);
      continue;
    }
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(absolute);
    } catch {
      changed.push(path);
      continue;
    }
    if (stat.size === record.size && Math.trunc(stat.mtimeMs) === Math.trunc(record.modifiedAt))
      continue;
    if (indexedContentHashOfFile(absolute) !== record.contentHash) changed.push(path);
  }
  for (const path of indexed.keys()) {
    if (!listed.has(path) && !NodeFS.existsSync(NodePath.resolve(checkoutPath, path)))
      changed.push(path);
  }
  return changed;
}

function selectSymbols(
  graph: CodeGraphInstance,
  input: ProjectCodeSymbolSelector,
  limit: number,
  allowedPaths: ReadonlySet<string>,
): ProjectCodeSymbol[] {
  return graph
    .getNodesByName(input.name)
    .filter((node) => allowedPaths.has(node.filePath))
    .filter((node) => input.filePath === undefined || node.filePath === input.filePath)
    .filter(
      (node) =>
        input.line === undefined || (node.startLine <= input.line && input.line <= node.endLine),
    )
    .slice(0, limit + 1)
    .map(mapSymbol);
}

function exactDigest(
  checkoutPath: string,
  graph: CodeGraphInstance,
  relativePath: string,
): ProjectCodeSourceDigest {
  const normalizedPath = safeRelativePath(checkoutPath, relativePath);
  if (normalizedPath === null) return { path: relativePath, digest: "", verified: false };
  try {
    const absolutePath = NodePath.resolve(checkoutPath, normalizedPath);
    const realCheckout = NodeFS.realpathSync(checkoutPath);
    const realSource = NodeFS.realpathSync(absolutePath);
    const realRelative = NodePath.relative(realCheckout, realSource);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(realRelative)
    ) {
      return { path: normalizedPath, digest: "", verified: false };
    }
    const descriptor = NodeFS.openSync(realSource, "r");
    let source: ReturnType<typeof readBoundedSource>;
    let stableRead: boolean;
    try {
      const before = NodeFS.fstatSync(descriptor);
      source = readBoundedSource(descriptor);
      const after = NodeFS.fstatSync(descriptor);
      stableRead =
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        NodeFS.realpathSync(absolutePath) === realSource;
    } finally {
      NodeFS.closeSync(descriptor);
    }
    const indexedHash = graph.getFile(normalizedPath)?.contentHash;
    // Over the limit the index knows only the size, so that is all there is to verify, and
    // the bytes are not read to produce a digest.
    if (source.bytes === null) {
      return {
        path: normalizedPath,
        digest: "",
        verified: stableRead && indexedHash === indexedContentHash(source),
      };
    }
    const digest = sha256(source.bytes);
    let validUtf8 = true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    } catch {
      validUtf8 = false;
    }
    return {
      path: normalizedPath,
      digest,
      verified: stableRead && validUtf8 && indexedHash === digest,
    };
  } catch {
    return { path: normalizedPath, digest: "", verified: false };
  }
}

// What the SDK's getCallers and getCallees follow.
const CALL_EDGE_KINDS: ReadonlySet<string> = new Set([
  "calls",
  "references",
  "imports",
  "instantiates",
  "navigates",
]);
// Impact walks into these nodes' members, as the SDK's getImpactRadius does.
const CONTAINER_KINDS: ReadonlySet<string> = new Set([
  "class",
  "interface",
  "struct",
  "union",
  "trait",
  "protocol",
  "module",
  "enum",
]);

/**
 * Breadth first from `startId`, one node's edges at a time, so the nearest relations are the
 * ones kept and the walk stops at its node, edge, or visit budget instead of collecting
 * everything reachable first. Nodes outside `allowed` are neither returned nor walked through.
 */
function walkRelations(
  graph: CodeGraphInstance,
  startId: string,
  options: {
    readonly direction: "incoming" | "outgoing";
    readonly follows: (edge: Edge) => boolean;
    readonly depth: number;
    readonly allowed: ReadonlySet<string>;
    readonly maxNodes: number;
    readonly maxEdges: number;
    // Impact keeps every dependency edge between kept nodes and walks into containers.
    readonly impact?: boolean;
  },
) {
  const nodes: CodeGraphNode[] = [];
  const edges: Edge[] = [];
  const visited = new Set([startId]);
  const keep = (edge: Edge) => {
    if (edges.length >= options.maxEdges) return false;
    edges.push(edge);
    return true;
  };
  const enter = (node: CodeGraphNode, edge: Edge) => {
    if (nodes.length >= options.maxNodes || visited.size >= MAX_WALK_NODES || !keep(edge))
      return false;
    visited.add(node.id);
    nodes.push(node);
    return true;
  };
  let frontier = [startId];
  for (let hop = 0; hop < options.depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    // Container members join the frontier at the hop that reached their container.
    for (let index = 0; index < frontier.length; index += 1) {
      const id = frontier[index]!;
      if (options.impact && CONTAINER_KINDS.has(graph.getNode(id)?.kind ?? "")) {
        for (const edge of graph.getOutgoingEdges(id)) {
          if (edge.kind !== "contains" || visited.has(edge.target)) continue;
          const member = graph.getNode(edge.target);
          if (member === null || !options.allowed.has(member.filePath)) continue;
          if (!enter(member, edge)) return { nodes, edges, truncated: true };
          frontier.push(member.id);
        }
      }
      const adjacent =
        options.direction === "incoming" ? graph.getIncomingEdges(id) : graph.getOutgoingEdges(id);
      for (const edge of adjacent) {
        if (!options.follows(edge)) continue;
        const neighborId = options.direction === "incoming" ? edge.source : edge.target;
        if (visited.has(neighborId)) {
          if (options.impact && !keep(edge)) return { nodes, edges, truncated: true };
          continue;
        }
        const neighbor = graph.getNode(neighborId);
        if (neighbor === null || !options.allowed.has(neighbor.filePath)) continue;
        if (!enter(neighbor, edge)) return { nodes, edges, truncated: true };
        next.push(neighborId);
      }
    }
    frontier = next;
  }
  return { nodes, edges, truncated: false };
}

// A file outline lists declarations; these kinds are structure or noise there, and in search.
const FILE_OUTLINE_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
  "file",
  "import",
  "export",
  "parameter",
]);

/**
 * Top-level test code (an `it` callback) is attributed to the file, so a test file node is kept
 * only when the walk found no declaration in that file to name instead.
 */
function preferDeclarations(tests: ReadonlyArray<CodeGraphNode>): CodeGraphNode[] {
  const named = new Set(
    tests
      .filter((test) => !FILE_OUTLINE_EXCLUDED_KINDS.has(test.kind))
      .map((test) => test.filePath),
  );
  return tests.filter(
    (test) => !FILE_OUTLINE_EXCLUDED_KINDS.has(test.kind) || !named.has(test.filePath),
  );
}

type IsSupported = (path: string) => boolean;

function supportedPaths(sdk: Omit<CodeGraphModule, "CodeGraph">): IsSupported {
  const supported = new Set(sdk.getSupportedLanguages());
  return (path) => {
    const language = sdk.detectLanguage(path);
    return language !== "unknown" && supported.has(language);
  };
}

/**
 * Orders a listing for the file cap: what the analyzer can parse before what it cannot, and
 * first-party paths before dot-directories such as vendored references. Otherwise whatever sorts
 * first decides what is indexed, and a large `.repos` leaves a project's own code out entirely.
 */
export function rankListing(files: ReadonlyArray<string>, isSupported: IsSupported): string[] {
  const ranks: [string[], string[], string[], string[]] = [[], [], [], []];
  for (const path of files) {
    const hidden = path.startsWith(".") || path.includes("/.");
    ranks[(isSupported(path) ? 0 : 2) + (hidden ? 1 : 0)]!.push(path);
  }
  return ranks.flat();
}

function isListingTruncated(listing: CheckoutListing): boolean {
  return listing.listingTruncated || listing.files.length > MAX_LISTED_FILES;
}

interface AuthorizedListing {
  readonly paths: ReadonlyArray<string>;
  // Listed paths that resolve outside the checkout.
  readonly rejected: number;
}

function authorizedListing(listing: CheckoutListing, isSupported: IsSupported): AuthorizedListing {
  const candidates =
    listing.files.length > MAX_LISTED_FILES
      ? rankListing(listing.files, isSupported)
      : listing.files;
  const paths: string[] = [];
  let rejected = 0;
  for (const path of candidates) {
    if (paths.length >= MAX_LISTED_FILES) break;
    const absolute = NodePath.resolve(listing.checkoutPath, path);
    const authorized = authorizedSourcePath(listing.checkoutPath, path);
    if (authorized === null) {
      // A tracked file deleted from the working tree is no coverage gap; an escaping link is.
      if (NodeFS.existsSync(absolute)) rejected += 1;
      // Git lists a submodule as a path; handing the SDK a directory would walk past the allowlist.
    } else if (NodeFS.statSync(absolute, { throwIfNoEntry: false })?.isDirectory() !== true) {
      paths.push(authorized);
    }
  }
  return { paths, rejected };
}

/** Indexed sources that still exist but now resolve outside the checkout, such as a new link. */
function hasUnauthorizedFiles(checkoutPath: string, graph: CodeGraphInstance): boolean {
  return graph
    .getFiles()
    .some(
      (file) =>
        authorizedSourcePath(checkoutPath, file.path) === null &&
        NodeFS.existsSync(NodePath.resolve(checkoutPath, file.path)),
    );
}

/**
 * Builds the generation `input.to` from a copy of the published one, or from scratch, and reports
 * whether it differs from the published one. An unchanged checkout is detected before anything is
 * copied, and then `input.to` is never created.
 */
export async function buildIndexInWorker(
  input: CodeIndexBuildInput,
  onProgress: (progress: Pick<IndexProgress, "phase" | "current" | "total">) => void,
): Promise<{ readonly changed: boolean }> {
  const { CodeGraph, detectLanguage, getSupportedLanguages } = sdk();
  const isSupported = supportedPaths({ detectLanguage, getSupportedLanguages });
  const { paths: listedPaths } = authorizedListing(input, isSupported);
  const commit = headCommit(input.checkoutPath);
  const configurationDigest = checkoutConfigurationDigest(input.checkoutPath);
  let from = input.from;
  if (from !== null) {
    useIndexDirectory(from);
    const meta = readIndexMeta(input.indexRoot, from);
    if (
      !CodeGraph.isInitialized(input.indexRoot) ||
      // Filtering changes must remove old entries as well as reconsider previously skipped files.
      meta.configurationDigest !== configurationDigest ||
      // Successors keep every file they inherit, so one that spent the cap unranked never recovers.
      (isListingTruncated(input) && !meta.ranked)
    )
      from = null;
  }
  if (from !== null) {
    const published = await CodeGraph.open(input.indexRoot, { sync: false, readOnly: true });
    try {
      const meta = readIndexMeta(input.indexRoot, from);
      if (
        meta.commit === commit &&
        !hasUnauthorizedFiles(input.checkoutPath, published) &&
        changedSinceIndex(
          input.checkoutPath,
          published,
          listedPaths,
          isSupported,
          meta.skippedPaths,
        ).length === 0
      ) {
        return { changed: false };
      }
    } finally {
      published.close();
    }
  }
  const target = NodePath.join(input.indexRoot, input.to);
  // Exclusive: a leftover entry, link or not, fails the build instead of being written through.
  NodeFS.mkdirSync(target);
  if (from !== null) {
    for (const name of INDEX_DATABASE_FILES) {
      const source = NodePath.join(input.indexRoot, from, name);
      if (NodeFS.existsSync(source)) {
        NodeFS.copyFileSync(
          source,
          NodePath.join(target, name),
          // FICLONE falls back to a normal copy where reflinks are unavailable.
          NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
        );
      }
    }
  }
  useIndexDirectory(input.to);
  let graph =
    from !== null
      ? await CodeGraph.open(input.indexRoot, { sync: false })
      : await CodeGraph.init(input.indexRoot, { index: false });
  try {
    if (hasUnauthorizedFiles(input.checkoutPath, graph)) {
      graph.close();
      graph = await CodeGraph.recreate(input.indexRoot);
    }
    const reconcilePaths = new Set(listedPaths);
    for (const file of graph.getFiles()) {
      if (reconcilePaths.size >= MAX_LISTED_FILES * 2) break;
      const authorized = authorizedSourcePath(input.checkoutPath, file.path);
      if (authorized !== null) reconcilePaths.add(authorized);
      else if (!NodeFS.existsSync(NodePath.resolve(input.checkoutPath, file.path)))
        reconcilePaths.add(file.path);
    }
    // From the reconcile set, not the listing: the cap can drop a top-level entry the graph still
    // holds files under, and the SDK would read those as deleted.
    clearCheckoutSources(input.indexRoot);
    linkCheckoutSources(input.indexRoot, input.checkoutPath, [...reconcilePaths]);
    // `sync` reads an empty `paths` as "reconcile the whole checkout", a walk that follows
    // links out of it. It and the no-index `init`/`open`/`recreate` are the SDK's only calls
    // here, so this allowlist bounds everything the index reads.
    if (reconcilePaths.size > 0) await graph.sync({ onProgress, paths: [...reconcilePaths] });
    const indexedPaths = new Set(graph.getFiles().map((file) => file.path));
    writeIndexMeta(input.indexRoot, input.to, {
      commit,
      generation: input.generation,
      indexedAt: Date.now(),
      // A completed sync may deliberately skip build output. Those paths are coverage gaps,
      // not newly added files that the next refresh can fix.
      skippedPaths: listedPaths.filter((path) => !indexedPaths.has(path)).toSorted(),
      ranked: true,
      configurationDigest,
    });
  } finally {
    graph.close();
  }
  return { changed: true };
}

/** Answers from the published generation, read-only; a checkout without one is unindexed. */
export async function inspectCodeInWorker(
  input: CodeIntelligenceWorkerInput,
): Promise<ProjectCodeQueryResult> {
  const { CodeGraph, detectLanguage, getSupportedLanguages } = sdk();
  const isSupported = supportedPaths({ detectLanguage, getSupportedLanguages });
  const listing = authorizedListing(input, isSupported);
  const listedPaths = listing.paths;
  const listedPathSet = new Set(listedPaths);
  const queryPath =
    input.query.operation === "dependencies" ||
    input.query.operation === "symbols" ||
    input.query.operation === "affected"
      ? input.query.filePath
      : input.query.operation === "callers" ||
          input.query.operation === "callees" ||
          input.query.operation === "references" ||
          input.query.operation === "impact" ||
          input.query.operation === "tests"
        ? input.query.symbol.filePath
        : undefined;
  const queryPaths =
    input.query.operation === "path"
      ? [input.query.from.filePath, input.query.to.filePath]
      : [queryPath];
  for (const path of queryPaths) {
    if (
      path !== undefined &&
      safeRelativePath(input.checkoutPath, path) !== null &&
      authorizedSourcePath(input.checkoutPath, path) === null
    ) {
      throw new Error("path-outside-checkout");
    }
  }
  const commit = headCommit(input.checkoutPath);
  if (input.indexDirectory !== null) {
    useIndexDirectory(input.indexDirectory);
  }
  if (input.indexDirectory === null || !CodeGraph.isInitialized(input.indexRoot)) {
    return unindexedResult(input, getSupportedLanguages(), commit);
  }
  const graph = await CodeGraph.open(input.indexRoot, { sync: false, readOnly: true });
  try {
    const meta = readIndexMeta(input.indexRoot, input.indexDirectory);
    if (input.query.operation === "freshness") {
      return inspectFreshness(
        input,
        listing,
        graph,
        meta,
        commit,
        getSupportedLanguages(),
        isSupported,
      );
    }
    const languageCatalog = getSupportedLanguages();
    const indexCoverage = classifyIndexCoverage(input, listing, graph, isSupported);
    const files = indexCoverage.files;
    const stats = graph.getStats();
    const limit = Math.min(
      input.query.operation === "status" || input.query.operation === "path"
        ? MAX_RESULTS
        : (input.query.limit ?? 100),
      MAX_RESULTS,
    );
    const matches: ProjectCodeMatch[] = [];
    const nodes = new Map<string, ProjectCodeSymbol>();
    const edges = new Map<string, ProjectCodeEdge>();
    const relatedFiles = new Set<string>();
    const unresolvedReferences: ProjectCodeUnresolvedReference[] = [];
    let selection: ProjectCodeSelection = { state: "not-required", candidates: [] };
    let resultLimitReached = false;
    const symbolGroups: ProjectCodeSymbolGroup[] = [];
    let pathSearch: ProjectCodePathSearch | null = null;

    const addNode = (node: CodeGraphNode) => {
      if (!listedPathSet.has(node.filePath)) return;
      if (nodes.size >= limit && !nodes.has(node.id)) {
        resultLimitReached = true;
        return;
      }
      const symbol = mapSymbol(node);
      nodes.set(node.id, symbol);
      relatedFiles.add(symbol.path);
    };
    const addEdge = (edge: Edge) => {
      const source = graph.getNode(edge.source);
      const target = graph.getNode(edge.target);
      if (
        source === null ||
        target === null ||
        !listedPathSet.has(source.filePath) ||
        !listedPathSet.has(target.filePath)
      )
        return;
      const id = `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.line ?? ""}\0${edge.column ?? ""}`;
      if (edges.size >= limit && !edges.has(id)) {
        resultLimitReached = true;
        return;
      }
      edges.set(id, mapEdge(edge, graph, listedPathSet));
    };
    const addPair = (pair: { readonly node: CodeGraphNode; readonly edge: Edge }) => {
      addNode(pair.node);
      addEdge(pair.edge);
    };

    /**
     * Walks usages outward from `startId`, breadth first, and returns the test-file symbols it
     * reaches with the edges that led to each. Use sites are static candidates, so a reached
     * test is a reachability claim, never a coverage one.
     */
    const reachingTests = (startId: string, depth: number, maxTests: number) => {
      const via = new Map<string, Edge>();
      const visited = new Set([startId]);
      const tests: CodeGraphNode[] = [];
      let frontier = [startId];
      for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const usage of graph.findUsages(id)) {
            if (visited.has(usage.node.id) || !listedPathSet.has(usage.node.filePath)) continue;
            if (visited.size >= MAX_WALK_NODES)
              return { tests: preferDeclarations(tests), via, truncated: true };
            visited.add(usage.node.id);
            via.set(usage.node.id, usage.edge);
            if (isLikelyTestPath(usage.node.filePath)) {
              tests.push(usage.node);
              if (tests.length >= maxTests)
                return { tests: preferDeclarations(tests), via, truncated: true };
            } else next.push(usage.node.id);
          }
        }
        frontier = next;
      }
      return { tests: preferDeclarations(tests), via, truncated: false };
    };
    const addTestChain = (test: CodeGraphNode, startId: string, via: Map<string, Edge>) => {
      let current: CodeGraphNode | null = test;
      while (current !== null && current.id !== startId) {
        addNode(current);
        const edge = via.get(current.id);
        if (edge === undefined) break;
        addEdge(edge);
        current = graph.getNode(edge.target);
      }
    };

    switch (input.query.operation) {
      case "search": {
        const results = graph
          .searchNodes(input.query.text, { limit: MAX_RESULTS })
          .filter((result) => listedPathSet.has(result.node.filePath))
          .filter(
            (result) =>
              result.node.kind === "file" || !FILE_OUTLINE_EXCLUDED_KINDS.has(result.node.kind),
          )
          .slice(0, limit + 1);
        if (results.length >= limit) resultLimitReached = true;
        for (const result of results) {
          if (matches.length >= limit) {
            resultLimitReached = true;
            break;
          }
          const match = mapMatch(result);
          matches.push(match);
          addNode(result.node);
        }
        break;
      }
      case "symbols": {
        const query = input.query;
        const found =
          query.name === undefined
            ? query.filePath === undefined
              ? []
              : graph
                  .getNodesInFile(query.filePath)
                  .filter((candidate) => !FILE_OUTLINE_EXCLUDED_KINDS.has(candidate.kind))
                  .toSorted(
                    (left, right) =>
                      left.startLine - right.startLine || left.startColumn - right.startColumn,
                  )
            : graph.getNodesByName(query.name);
        for (const node of found
          .filter((candidate) => listedPathSet.has(candidate.filePath))
          .filter(
            (candidate) => query.filePath === undefined || candidate.filePath === query.filePath,
          )
          .slice(0, limit + 1)) {
          if (nodes.size >= limit) {
            resultLimitReached = true;
            break;
          }
          addNode(node);
        }
        break;
      }
      case "affected": {
        const query = input.query;
        const path = safeRelativePath(input.checkoutPath, query.filePath);
        if (path === null || !listedPathSet.has(path)) break;
        relatedFiles.add(path);
        const ranges = query.lineRanges;
        const changed = graph
          .getNodesInFile(path)
          .filter((node) => !FILE_OUTLINE_EXCLUDED_KINDS.has(node.kind))
          .filter(
            (node) =>
              ranges === undefined ||
              ranges.some((range) => node.startLine <= range.end && range.start <= node.endLine),
          )
          .toSorted((left, right) => left.startLine - right.startLine);
        const symbolLimit = Math.min(query.limit ?? MAX_AFFECTED_SYMBOLS, MAX_AFFECTED_SYMBOLS);
        if (changed.length > symbolLimit) resultLimitReached = true;
        for (const node of changed.slice(0, symbolLimit)) {
          addNode(node);
          const callers = graph
            .getCallers(node.id, 1)
            .filter((usage) => listedPathSet.has(usage.node.filePath));
          if (callers.length > AFFECTED_CALLERS_PER_SYMBOL) resultLimitReached = true;
          const keptCallers = callers.slice(0, AFFECTED_CALLERS_PER_SYMBOL);
          keptCallers.forEach(addPair);
          const walk = reachingTests(node.id, 3, AFFECTED_TESTS_PER_SYMBOL);
          if (walk.truncated) resultLimitReached = true;
          walk.tests.forEach(addNode);
          symbolGroups.push({
            symbol: node.id.slice(0, 2048),
            callers: keptCallers
              .filter((usage) => nodes.has(usage.node.id))
              .map((usage) => usage.node.id.slice(0, 2048)),
            tests: walk.tests
              .filter((test) => nodes.has(test.id))
              .map((test) => test.id.slice(0, 2048)),
          });
        }
        break;
      }
      case "callers":
      case "callees":
      case "references":
      case "impact":
      case "tests": {
        const candidates = selectSymbols(graph, input.query.symbol, limit, listedPathSet);
        if (candidates.length === 0) {
          selection = { state: "not-found", candidates: [] };
          break;
        }
        if (candidates.length !== 1) {
          selection = { state: "ambiguous", candidates: candidates.slice(0, limit) };
          resultLimitReached = candidates.length > limit;
          candidates.slice(0, limit).forEach((candidate) => relatedFiles.add(candidate.path));
          break;
        }
        selection = { state: "matched", candidates };
        const selected = candidates[0]!;
        const selectedNode = graph.getNode(selected.id);
        if (selectedNode === null || !listedPathSet.has(selectedNode.filePath)) {
          selection = { state: "not-found", candidates: [] };
          break;
        }
        addNode(selectedNode);
        const relations = (
          walk: Omit<Parameters<typeof walkRelations>[2], "allowed" | "maxNodes" | "maxEdges">,
        ) => {
          // The selected symbol takes one of the `limit` node slots.
          const found = walkRelations(graph, selected.id, {
            ...walk,
            allowed: listedPathSet,
            maxNodes: limit - 1,
            maxEdges: limit,
          });
          found.nodes.forEach(addNode);
          found.edges.forEach(addEdge);
          if (found.truncated) resultLimitReached = true;
        };
        if (input.query.operation === "callers" || input.query.operation === "callees") {
          relations({
            direction: input.query.operation === "callers" ? "incoming" : "outgoing",
            follows: (edge) => CALL_EDGE_KINDS.has(edge.kind),
            depth: input.query.depth ?? 1,
          });
        } else if (input.query.operation === "tests") {
          const walk = reachingTests(selected.id, input.query.depth ?? 3, limit);
          if (walk.truncated) resultLimitReached = true;
          for (const test of walk.tests) addTestChain(test, selected.id, walk.via);
          symbolGroups.push({
            symbol: selected.id.slice(0, 2048),
            callers: [],
            tests: walk.tests
              .filter((test) => nodes.has(test.id))
              .map((test) => test.id.slice(0, 2048)),
          });
        } else if (input.query.operation === "references") {
          relations({ direction: "incoming", follows: () => true, depth: 1 });
        } else {
          relations({
            direction: "incoming",
            // A container contains its members but does not depend on them.
            follows: (edge) => edge.kind !== "contains",
            depth: input.query.depth ?? 3,
            impact: true,
          });
        }
        for (const unresolved of graph.getUnresolvedReferencesInFile(selected.path, limit)) {
          const source = graph.getNode(unresolved.fromNodeId);
          if (source === null || !listedPathSet.has(source.filePath)) continue;
          if (unresolvedReferences.length >= limit) {
            resultLimitReached = true;
            break;
          }
          unresolvedReferences.push(mapUnresolved(unresolved, graph, listedPathSet));
        }
        break;
      }
      case "path": {
        const query = input.query;
        const maxDepth = query.depth ?? DEFAULT_PATH_DEPTH;
        const fromCandidates = selectSymbols(graph, query.from, limit, listedPathSet);
        const toCandidates =
          fromCandidates.length === 1 ? selectSymbols(graph, query.to, limit, listedPathSet) : [];
        const unresolvedEndpoint =
          fromCandidates.length !== 1 ? "from" : toCandidates.length !== 1 ? "to" : null;
        if (unresolvedEndpoint !== null) {
          const candidates = unresolvedEndpoint === "from" ? fromCandidates : toCandidates;
          selection = {
            state: candidates.length === 0 ? "not-found" : "ambiguous",
            candidates: candidates.slice(0, limit),
          };
          resultLimitReached = candidates.length > limit;
          pathSearch = {
            found: false,
            maxDepth,
            visitedSymbols: 0,
            walkTruncated: false,
            unresolvedEndpoint,
          };
          break;
        }
        const from = fromCandidates[0]!;
        const targetId = toCandidates[0]!.id;
        selection = { state: "matched", candidates: [from, toCandidates[0]!] };
        // Breadth first over the same outgoing kinds `callees` follows, so the shortest route
        // within the bound is the one returned.
        const via = new Map<string, Edge>();
        const visited = new Set([from.id]);
        let frontier = [from.id];
        let found = from.id === targetId;
        let walkTruncated = false;
        walk: for (let hop = 0; hop < maxDepth && frontier.length > 0 && !found; hop += 1) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const callee of graph.getCallees(id, 1)) {
              if (visited.has(callee.node.id) || !listedPathSet.has(callee.node.filePath)) continue;
              if (visited.size >= MAX_WALK_NODES) {
                walkTruncated = true;
                break walk;
              }
              visited.add(callee.node.id);
              via.set(callee.node.id, callee.edge);
              if (callee.node.id === targetId) {
                found = true;
                break walk;
              }
              next.push(callee.node.id);
            }
          }
          frontier = next;
        }
        if (found) {
          const route: Edge[] = [];
          for (let id = targetId; id !== from.id;) {
            const edge = via.get(id);
            if (edge === undefined) break;
            route.unshift(edge);
            id = edge.source;
          }
          const fromNode = graph.getNode(from.id);
          if (fromNode !== null) addNode(fromNode);
          for (const edge of route) {
            const target = graph.getNode(edge.target);
            if (target !== null) addNode(target);
            addEdge(edge);
          }
        }
        pathSearch = {
          found,
          maxDepth,
          visitedSymbols: visited.size,
          walkTruncated,
          unresolvedEndpoint: null,
        };
        break;
      }
      case "dependencies": {
        const path = safeRelativePath(input.checkoutPath, input.query.filePath);
        if (path === null || !listedPathSet.has(path)) break;
        const related =
          input.query.direction === "imports"
            ? graph.getFileDependencies(path)
            : graph.getFileDependents(path);
        relatedFiles.add(path);
        const authorizedRelated = related.filter((relatedPath) => listedPathSet.has(relatedPath));
        for (const relatedPath of authorizedRelated.slice(0, limit)) {
          relatedFiles.add(relatedPath);
          graph.getNodesInFile(relatedPath).forEach(addNode);
        }
        if (authorizedRelated.length > limit) resultLimitReached = true;
        break;
      }
      case "status":
        break;
    }

    const sourceDigests = [...relatedFiles]
      .slice(0, MAX_FILES_FOR_UNRESOLVED)
      .map((path) => exactDigest(input.checkoutPath, graph, path));
    if (relatedFiles.size > sourceDigests.length) resultLimitReached = true;
    const limitations: string[] = [];
    limitations.push(
      "Relations are static candidates. Import/name resolution can misresolve shadowed names, and SDK confidence is a heuristic score rather than certainty.",
    );
    limitations.push(...indexCoverage.limitations);
    let coverageIncomplete = indexCoverage.incomplete;
    if (sourceDigests.some((source) => !source.verified)) {
      coverageIncomplete = true;
      limitations.push(
        "One or more returned source files are invalid UTF-8 or no longer match the graph index.",
      );
    }
    if (resultLimitReached) {
      coverageIncomplete = true;
      limitations.push(`Query results were limited to ${limit} rows per section.`);
    }
    // The published generation may trail the checkout while its successor builds.
    const changed = changedSinceIndex(
      input.checkoutPath,
      graph,
      listedPaths,
      isSupported,
      meta.skippedPaths,
    );
    const configurationChanged =
      meta.configurationDigest !== checkoutConfigurationDigest(input.checkoutPath);
    if (changed.length > 0) {
      limitations.push(
        `${changed.length} source ${changed.length === 1 ? "file has" : "files have"} changed since this index generation was built.`,
      );
    }
    if (configurationChanged) limitations.push("The checkout's index configuration has changed.");
    const stale =
      configurationChanged ||
      changed.length > 0 ||
      sourceDigests.some((source) => !source.verified);
    const coverage: ProjectCodeCoverage = {
      state: stale ? "stale" : coverageIncomplete ? "partial" : "complete",
      catalogRevision: CATALOG_REVISION,
      relationSemantics: "static-candidates",
      columnEncoding: "utf16-code-units",
      languages: [...languageCatalog],
      indexedLanguages: indexedLanguages(files),
      filesListed: input.filesListed,
      filesIndexed: files.length,
      filesSkipped: indexCoverage.filesSkipped,
      filesUnsupported: indexCoverage.filesUnsupported,
      filesFailed: indexCoverage.filesFailed,
      pendingReferences: indexCoverage.pendingReferences,
      resultLimitReached,
      limitations,
    };
    const outputStats: ProjectCodeStats = {
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      files: files.length,
      lastUpdated: stats.lastUpdated,
    };
    return {
      operation: input.query.operation,
      checkoutPath: input.checkoutPath,
      matches,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      files: [...relatedFiles].slice(0, limit).map((path): ProjectCodeFile => ({ path })),
      unresolvedReferences,
      selection,
      sourceDigests,
      stats: input.query.operation === "status" ? outputStats : null,
      coverage,
      index: {
        state:
          coverage.state === "stale"
            ? "stale"
            : coverage.state === "complete"
              ? "ready"
              : "partial",
        indexedCommit: meta.commit,
        headCommit: commit,
        generation: meta.generation,
        indexedAt: meta.indexedAt,
        changedFiles: changed.length,
        changedPaths: changed.slice(0, 20).map((path) => path.slice(0, 2048)),
      },
      ...(symbolGroups.length > 0 ? { symbolGroups } : {}),
      ...(pathSearch !== null ? { pathSearch } : {}),
    };
  } finally {
    graph.close();
  }
}

/**
 * How much of the listed checkout the index covers, counted the same way for a query and for
 * freshness. Every limitation but unsupported files makes coverage partial: docs, data and assets
 * fill any repository, so they are a gap only when nothing else could be indexed. Source the SDK
 * cannot read is a gap once it is a real share of the code, not for one stray script.
 */
function classifyIndexCoverage(
  input: CheckoutListing,
  { paths: listedPaths, rejected }: AuthorizedListing,
  graph: CodeGraphInstance,
  isSupported: IsSupported,
) {
  const listed = new Set(listedPaths);
  const files = graph.getFiles().filter((file) => listed.has(file.path));
  const indexedPaths = new Set(files.map((file) => file.path));
  const filesUnsupported = listedPaths.filter(
    (path) => !isSupported(path) && !indexedPaths.has(path),
  ).length;
  const filesFailed = files.filter((file) => (file.errors?.length ?? 0) > 0).length;
  const filesSkipped =
    rejected + listedPaths.filter((path) => isSupported(path) && !indexedPaths.has(path)).length;
  const pendingReferences = graph.getPendingReferenceCount();
  const buildState = graph.getIndexState();
  const limitations: string[] = [];
  if (isListingTruncated(input)) limitations.push("Workspace file listing is truncated.");
  if (filesSkipped > 0)
    limitations.push(
      `${filesSkipped} listed source files were outside the checkout or were not indexed.`,
    );
  if (filesFailed > 0) limitations.push(`${filesFailed} indexed files report extraction errors.`);
  if (pendingReferences > 0)
    limitations.push(
      "The graph index has unresolved pending references from an interrupted resolution pass.",
    );
  if (buildState !== null && buildState !== "complete")
    limitations.push(`The last full index run reported '${buildState}'.`);
  const unreadableSource = listedPaths.filter(
    (path) => UNREADABLE_SOURCE.test(path) && !isSupported(path) && !indexedPaths.has(path),
  ).length;
  const incomplete =
    limitations.length > 0 ||
    (filesUnsupported > 0 && files.length === 0) ||
    unreadableSource * 20 > files.length + unreadableSource;
  if (filesUnsupported > 0)
    limitations.push(
      `${filesUnsupported} listed files use languages outside the SDK runtime catalog.`,
    );
  return {
    files,
    filesSkipped,
    filesUnsupported,
    filesFailed,
    pendingReferences,
    limitations,
    incomplete,
  };
}

function indexedLanguages(files: ReadonlyArray<{ readonly language: string }>): string[] {
  return [...new Set(files.map((file) => file.language))]
    .filter((language) => language !== "unknown")
    .toSorted()
    .slice(0, 64);
}

function emptyResult(
  input: CodeIntelligenceWorkerInput,
  coverage: ProjectCodeCoverage,
  index: ProjectCodeIndexInfo,
): ProjectCodeQueryResult {
  return {
    operation: input.query.operation,
    checkoutPath: input.checkoutPath,
    matches: [],
    nodes: [],
    edges: [],
    files: [],
    unresolvedReferences: [],
    selection: { state: "not-required", candidates: [] },
    sourceDigests: [],
    stats: null,
    coverage,
    index,
  };
}

function baseCoverage(input: CodeIntelligenceWorkerInput, languages: ReadonlyArray<Language>) {
  return {
    catalogRevision: CATALOG_REVISION,
    relationSemantics: "static-candidates" as const,
    columnEncoding: "utf16-code-units" as const,
    languages: [...languages],
    filesListed: input.filesListed,
    filesSkipped: 0,
    filesUnsupported: 0,
    filesFailed: 0,
    resultLimitReached: false,
  };
}

function unindexedResult(
  input: CodeIntelligenceWorkerInput,
  languages: ReadonlyArray<Language>,
  commit: string | null,
): ProjectCodeQueryResult {
  return emptyResult(
    input,
    {
      ...baseCoverage(input, languages),
      state: "unavailable",
      filesIndexed: 0,
      indexedLanguages: [],
      pendingReferences: 0,
      limitations: ["This checkout has not been indexed yet. A code query starts indexing it."],
    },
    {
      state: "unindexed",
      indexedCommit: null,
      headCommit: commit,
      generation: 0,
      indexedAt: null,
      changedFiles: 0,
      changedPaths: [],
    },
  );
}

function inspectFreshness(
  input: CodeIntelligenceWorkerInput,
  listing: AuthorizedListing,
  graph: CodeGraphInstance,
  meta: IndexMeta,
  commit: string | null,
  languages: ReadonlyArray<Language>,
  isSupported: IsSupported,
): ProjectCodeQueryResult {
  const indexCoverage = classifyIndexCoverage(input, listing, graph, isSupported);
  const changed = changedSinceIndex(
    input.checkoutPath,
    graph,
    listing.paths,
    isSupported,
    meta.skippedPaths,
  );
  const configurationChanged =
    meta.configurationDigest !== checkoutConfigurationDigest(input.checkoutPath);
  const stale = changed.length > 0 || configurationChanged;
  const { incomplete } = indexCoverage;
  const limitations = [
    ...(changed.length > 0
      ? [
          `${changed.length} source ${changed.length === 1 ? "file has" : "files have"} changed since the last index. The next code query or turn checkpoint refreshes it.`,
        ]
      : []),
    ...indexCoverage.limitations,
    ...(configurationChanged ? ["The checkout's index configuration has changed."] : []),
  ];
  return emptyResult(
    input,
    {
      ...baseCoverage(input, languages),
      state: stale ? "stale" : incomplete ? "partial" : "complete",
      filesIndexed: indexCoverage.files.length,
      filesSkipped: indexCoverage.filesSkipped,
      filesUnsupported: indexCoverage.filesUnsupported,
      filesFailed: indexCoverage.filesFailed,
      indexedLanguages: indexedLanguages(indexCoverage.files),
      pendingReferences: indexCoverage.pendingReferences,
      limitations,
    },
    {
      state: stale ? "stale" : incomplete ? "partial" : "ready",
      indexedCommit: meta.commit,
      headCommit: commit,
      generation: meta.generation,
      indexedAt: meta.indexedAt,
      changedFiles: changed.length,
      changedPaths: changed.slice(0, 20).map((path) => path.slice(0, 2048)),
    },
  );
}
