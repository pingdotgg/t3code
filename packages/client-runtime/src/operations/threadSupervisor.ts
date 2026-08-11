import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

declare const SupervisorTargetHandleBrand: unique symbol;
declare const SupervisorProposalHandleBrand: unique symbol;
declare const SupervisorTargetVersionBrand: unique symbol;

export type SupervisorTargetHandle = string & {
  readonly [SupervisorTargetHandleBrand]: "SupervisorTargetHandle";
};
export type SupervisorProposalHandle = string & {
  readonly [SupervisorProposalHandleBrand]: "SupervisorProposalHandle";
};
export type SupervisorTargetVersion = string & {
  readonly [SupervisorTargetVersionBrand]: "SupervisorTargetVersion";
};

export function makeSupervisorTargetVersion(value: string): SupervisorTargetVersion {
  if (value.trim().length === 0) {
    throw new Error("Supervisor target versions must not be empty.");
  }
  return value as SupervisorTargetVersion;
}

export type SupervisorTargetBinding =
  | {
      readonly kind: "project";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly version: SupervisorTargetVersion;
    }
  | {
      readonly kind: "thread";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly version: SupervisorTargetVersion;
    };

export type SupervisorTargetAvailability = "live" | "stale" | "disconnected";

export interface SupervisorTargetCandidate {
  readonly binding: SupervisorTargetBinding;
  readonly label: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly availability: SupervisorTargetAvailability;
}

export interface PublishedSupervisorTarget {
  readonly handle: SupervisorTargetHandle;
  readonly kind: SupervisorTargetBinding["kind"];
  readonly label: string;
  readonly availability: SupervisorTargetAvailability;
  readonly expiresAtEpochMs: number;
}

export interface BoundedSupervisorReadResult<T> {
  readonly items: ReadonlyArray<T>;
  readonly totalCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

export interface SupervisorReadBounds {
  readonly requestedLimit?: number;
  readonly maxItems: number;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative integer.`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive integer.`);
  }
  return value;
}

export function boundSupervisorText(value: string, maxChars: number): string {
  const limit = requireNonNegativeInteger(maxChars, "maxChars");
  if (value.length <= limit) return value;
  if (limit <= 3) return value.slice(0, limit);
  return `${value.slice(0, limit - 3).trimEnd()}...`;
}

export function createBoundedSupervisorReadResult<T>(
  items: ReadonlyArray<T>,
  bounds: SupervisorReadBounds,
): BoundedSupervisorReadResult<T> {
  const maximum = requireNonNegativeInteger(bounds.maxItems, "maxItems");
  const requested =
    bounds.requestedLimit === undefined
      ? maximum
      : requireNonNegativeInteger(bounds.requestedLimit, "requestedLimit");
  const boundedItems = Object.freeze(items.slice(0, Math.min(maximum, requested)));
  const omittedCount = Math.max(0, items.length - boundedItems.length);
  return Object.freeze({
    items: boundedItems,
    totalCount: items.length,
    omittedCount,
    truncated: omittedCount > 0,
  });
}

export interface SupervisorJsonSnapshotBounds {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
}

export type SupervisorJsonSnapshotFailureReason =
  | "unsupported-type"
  | "unsupported-object"
  | "accessor"
  | "non-enumerable"
  | "symbol-key"
  | "unsafe-key"
  | "cycle"
  | "non-finite-number"
  | "depth-limit"
  | "node-limit"
  | "byte-limit"
  | "key-limit"
  | "array-limit";

export type SupervisorJsonSnapshotResult =
  | {
      readonly status: "accepted";
      readonly value: Schema.Json;
      readonly signature: string;
      readonly bytes: number;
    }
  | {
      readonly status: "rejected";
      readonly reason: SupervisorJsonSnapshotFailureReason;
      readonly path: string;
    };

const UNSAFE_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonStringBytes(value: string): number {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 0 : utf8ByteLength(encoded);
}

/**
 * Copies unknown input into a deeply frozen, bounded JSON value without
 * reading inherited fields or invoking property accessors.
 */
export function createSupervisorJsonSnapshot(
  input: unknown,
  bounds: SupervisorJsonSnapshotBounds,
): SupervisorJsonSnapshotResult {
  const maxDepth = requirePositiveInteger(bounds.maxDepth, "maxDepth");
  const maxNodes = requirePositiveInteger(bounds.maxNodes, "maxNodes");
  const maxBytes = requirePositiveInteger(bounds.maxBytes, "maxBytes");
  const maxKeys = requirePositiveInteger(bounds.maxKeys, "maxKeys");
  const maxArrayItems = requirePositiveInteger(bounds.maxArrayItems, "maxArrayItems");
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let keys = 0;
  let estimatedBytes = 0;
  let failure:
    | {
        readonly reason: SupervisorJsonSnapshotFailureReason;
        readonly path: string;
      }
    | undefined;

  const reject = (reason: SupervisorJsonSnapshotFailureReason, path: string) => {
    failure ??= { reason, path };
  };
  const addBytes = (count: number, path: string) => {
    estimatedBytes += count;
    if (estimatedBytes > maxBytes) reject("byte-limit", path);
  };

  const visit = (value: unknown, depth: number, path: string): Schema.Json | undefined => {
    if (failure !== undefined) return undefined;
    if (depth > maxDepth) {
      reject("depth-limit", path);
      return undefined;
    }
    nodes += 1;
    if (nodes > maxNodes) {
      reject("node-limit", path);
      return undefined;
    }

    if (value === null) {
      addBytes(4, path);
      return null;
    }
    if (typeof value === "string") {
      if (value.length > maxBytes) {
        reject("byte-limit", path);
        return undefined;
      }
      addBytes(jsonStringBytes(value), path);
      return value;
    }
    if (typeof value === "boolean") {
      addBytes(value ? 4 : 5, path);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        reject("non-finite-number", path);
        return undefined;
      }
      const normalized = Object.is(value, -0) ? 0 : value;
      addBytes(utf8ByteLength(String(normalized)), path);
      return normalized;
    }
    if (typeof value !== "object") {
      reject("unsupported-type", path);
      return undefined;
    }

    if (ancestors.has(value)) {
      reject("cycle", path);
      return undefined;
    }
    ancestors.add(value);

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        reject("unsupported-object", path);
        ancestors.delete(value);
        return undefined;
      }
      if (value.length > maxArrayItems) {
        reject("array-limit", path);
        ancestors.delete(value);
        return undefined;
      }
      keys += value.length;
      if (keys > maxKeys) {
        reject("key-limit", path);
        ancestors.delete(value);
        return undefined;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1) {
        reject("unsupported-object", path);
      }
      for (const key of ownKeys) {
        if (typeof key === "symbol") {
          reject("symbol-key", path);
          break;
        }
        if (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)) {
          reject("unsupported-object", `${path}.${key}`);
          break;
        }
      }
      addBytes(2 + Math.max(0, value.length - 1), path);
      const output: Schema.Json[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (failure !== undefined) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const itemPath = `${path}[${index}]`;
        if (descriptor === undefined) {
          reject("unsupported-object", itemPath);
          break;
        }
        if (!("value" in descriptor)) {
          reject("accessor", itemPath);
          break;
        }
        if (!descriptor.enumerable) {
          reject("non-enumerable", itemPath);
          break;
        }
        const item = visit(descriptor.value, depth + 1, itemPath);
        if (item !== undefined) output.push(item);
      }
      ancestors.delete(value);
      return failure === undefined ? Object.freeze(output) : undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      reject("unsupported-object", path);
      ancestors.delete(value);
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      reject("symbol-key", path);
      ancestors.delete(value);
      return undefined;
    }
    const stringKeys = ownKeys.filter((key): key is string => typeof key === "string").sort();
    keys += stringKeys.length;
    if (stringKeys.length > maxKeys || keys > maxKeys) {
      reject("key-limit", path);
      ancestors.delete(value);
      return undefined;
    }
    addBytes(2 + Math.max(0, stringKeys.length - 1), path);
    const output: Record<string, Schema.Json> = Object.create(null);
    for (const key of stringKeys) {
      if (key.length > maxBytes) {
        reject("byte-limit", `${path}.<oversized-key>`);
        break;
      }
      const propertyPath = `${path}.${key}`;
      if (UNSAFE_JSON_KEYS.has(key)) {
        reject("unsafe-key", propertyPath);
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        reject("unsupported-object", propertyPath);
        break;
      }
      if (!("value" in descriptor)) {
        reject("accessor", propertyPath);
        break;
      }
      if (!descriptor.enumerable) {
        reject("non-enumerable", propertyPath);
        break;
      }
      addBytes(jsonStringBytes(key) + 1, propertyPath);
      const property = visit(descriptor.value, depth + 1, propertyPath);
      if (property === undefined) break;
      Object.defineProperty(output, key, {
        value: property,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    ancestors.delete(value);
    return failure === undefined ? Object.freeze(output) : undefined;
  };

  let value: Schema.Json | undefined;
  try {
    value = visit(input, 0, "$json");
  } catch {
    return { status: "rejected", reason: "unsupported-object", path: "$json" };
  }
  if (failure !== undefined || value === undefined) {
    return {
      status: "rejected",
      reason: failure?.reason ?? "unsupported-type",
      path: failure?.path ?? "$json",
    };
  }
  const signature = JSON.stringify(value);
  if (signature === undefined) {
    return { status: "rejected", reason: "unsupported-type", path: "$json" };
  }
  const bytes = utf8ByteLength(signature);
  if (bytes > maxBytes) {
    return { status: "rejected", reason: "byte-limit", path: "$json" };
  }
  return Object.freeze({ status: "accepted", value, signature, bytes });
}

export interface SupervisorTargetResolutionCandidate {
  readonly handle: SupervisorTargetHandle;
  readonly kind: SupervisorTargetBinding["kind"];
  readonly label: string;
  readonly availability: SupervisorTargetAvailability;
}

export type SupervisorTargetResolution =
  | { readonly status: "resolved"; readonly target: SupervisorTargetResolutionCandidate }
  | {
      readonly status: "ambiguous" | "candidates";
      readonly candidates: ReadonlyArray<SupervisorTargetResolutionCandidate>;
    }
  | { readonly status: "not-found" }
  | { readonly status: "expired" };

export interface SupervisorMutationProposal {
  readonly handle: SupervisorProposalHandle;
  readonly action: string;
  readonly summary: string;
  readonly target: SupervisorTargetResolutionCandidate;
  readonly expiresAtEpochMs: number;
}

export type SupervisorCapacityResource = "calls" | "targets" | "proposals";
export type SupervisorMutationCapacityResource = "calls" | "proposals";

export type SupervisorMutationProposalResult =
  | {
      readonly status: "proposed";
      readonly proposal: SupervisorMutationProposal;
      readonly replacedProposalHandle?: SupervisorProposalHandle;
    }
  | { readonly status: "pending-proposal"; readonly proposal: SupervisorMutationProposal }
  | { readonly status: "not-found" | "target-expired" | "proposal-expired" }
  | {
      readonly status: "target-unavailable";
      readonly availability: Exclude<SupervisorTargetAvailability, "live">;
    }
  | {
      readonly status: "invalid-snapshot";
      readonly field: "mutation" | "preview";
      readonly reason: SupervisorJsonSnapshotFailureReason;
    }
  | { readonly status: "invalid-call-id" | "invalid-opaque-id" | "replacement-mismatch" }
  | {
      readonly status: "capacity-exceeded";
      readonly resource: SupervisorMutationCapacityResource;
    }
  | { readonly status: "call-id-conflict" };

export type SupervisorExecutionRejectionReason =
  | "disconnected"
  | "stale"
  | "missing"
  | "version-changed";

export type SupervisorConfirmedMutationResult =
  | { readonly status: "executed"; readonly value: Schema.Json }
  | { readonly status: "expired" | "cancelled" | "proposal-not-found" }
  | { readonly status: "replaced"; readonly replacementHandle: SupervisorProposalHandle }
  | { readonly status: "target-rejected"; readonly reason: SupervisorExecutionRejectionReason }
  | {
      readonly status: "execution-result-invalid";
      readonly reason: SupervisorJsonSnapshotFailureReason;
    }
  | { readonly status: "execution-failed" };

export type SupervisorExecutionAdapterResult =
  | { readonly status: "executed"; readonly value: unknown }
  | { readonly status: "rejected"; readonly reason: SupervisorExecutionRejectionReason };

export interface SupervisorMutationExecutionAdapter {
  readonly executeConfirmed: (input: {
    readonly target: SupervisorTargetBinding;
    readonly mutation: Schema.Json;
  }) => Promise<SupervisorExecutionAdapterResult>;
}

export interface SupervisorLocalConfirmationPayload {
  readonly proposal: SupervisorMutationProposal;
  readonly target: SupervisorTargetBinding;
  readonly preview: Schema.Json;
}

export type SupervisorLocalConfirmationState =
  | {
      readonly status: "pending" | "executing";
      readonly payload: SupervisorLocalConfirmationPayload;
    }
  | { readonly status: "settled" | "cancelled" | "expired" }
  | { readonly status: "replaced"; readonly replacementHandle: SupervisorProposalHandle }
  | { readonly status: "proposal-not-found" };

export type CancelSupervisorProposalResult =
  | { readonly status: "cancelled" }
  | {
      readonly status: "not-pending";
      readonly state: "executing" | "settled" | "cancelled" | "expired" | "replaced";
    }
  | { readonly status: "proposal-not-found" };

export interface CreateThreadSupervisorCoreOptions {
  readonly now: () => number;
  readonly makeOpaqueId: (kind: "target" | "proposal") => string;
  readonly targetTtlMs?: number;
  readonly proposalTtlMs?: number;
  readonly maxReadItems?: number;
  readonly maxTextChars?: number;
  readonly maxAmbiguousCandidates?: number;
  readonly maxAliasesPerTarget?: number;
  readonly maxCallIdChars?: number;
  readonly maxOpaqueIdChars?: number;
  readonly maxTargets?: number;
  readonly maxProposals?: number;
  readonly maxCalls?: number;
  readonly maxSnapshotDepth?: number;
  readonly maxSnapshotNodes?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxSnapshotKeys?: number;
  readonly maxSnapshotArrayItems?: number;
}

export interface PublishSupervisorTargetsInput {
  readonly callId: string;
  /** The collection being replaced, including when `targets` is empty. */
  readonly targetKind: SupervisorTargetBinding["kind"];
  readonly targets: ReadonlyArray<SupervisorTargetCandidate>;
  readonly requestedLimit?: number;
}

export type PublishSupervisorTargetsResult =
  | {
      readonly status: "published";
      readonly result: BoundedSupervisorReadResult<PublishedSupervisorTarget>;
    }
  | {
      readonly status:
        | "invalid-call-id"
        | "invalid-limit"
        | "invalid-opaque-id"
        | "invalid-target-set";
    }
  | { readonly status: "capacity-exceeded"; readonly resource: "calls" | "targets" }
  | { readonly status: "call-id-conflict" };

export interface ProposeSupervisorMutationInput {
  readonly callId: string;
  readonly targetHandle: string;
  readonly expectedTargetKind: SupervisorTargetBinding["kind"];
  readonly action: string;
  readonly summary: string;
  readonly mutation: unknown;
  /** Full trusted-UI confirmation data. Never included in the model-facing result. */
  readonly preview: unknown;
  readonly replacePendingProposal?: SupervisorProposalHandle;
}

export interface ThreadSupervisorCore {
  readonly publishTargets: (input: PublishSupervisorTargetsInput) => PublishSupervisorTargetsResult;
  readonly resolveTarget: (
    selector: string,
    expectedKind: SupervisorTargetBinding["kind"],
  ) => SupervisorTargetResolution;
  readonly proposeMutation: (
    input: ProposeSupervisorMutationInput,
  ) => SupervisorMutationProposalResult;
  readonly getConfirmationPayloadLocally: (
    handle: SupervisorProposalHandle,
  ) => SupervisorLocalConfirmationState;
  readonly cancelProposalLocally: (
    handle: SupervisorProposalHandle,
  ) => CancelSupervisorProposalResult;
  readonly confirmProposalLocally: (
    handle: SupervisorProposalHandle,
    adapter: SupervisorMutationExecutionAdapter,
  ) => Promise<SupervisorConfirmedMutationResult>;
}

interface NormalizedTargetCandidate {
  readonly binding: SupervisorTargetBinding;
  readonly bindingKey: string;
  readonly label: string;
  readonly aliases: ReadonlyArray<string>;
  readonly availability: SupervisorTargetAvailability;
}

interface StoredTarget {
  readonly binding: SupervisorTargetBinding;
  readonly bindingKey: string;
  readonly publicTarget: PublishedSupervisorTarget;
  readonly aliases: ReadonlyArray<string>;
  readonly expiresAtEpochMs: number;
  readonly publicationGeneration: number;
}

type StoredProposalState = "pending" | "executing" | "settled" | "cancelled" | "expired";

interface StoredProposal {
  readonly proposal: SupervisorMutationProposal;
  readonly target: StoredTarget;
  readonly mutation: Schema.Json;
  readonly confirmationPayload: SupervisorLocalConfirmationPayload;
  state: StoredProposalState | "replaced";
  replacementHandle?: SupervisorProposalHandle;
  execution?: Promise<SupervisorConfirmedMutationResult>;
}

type StoredCall =
  | {
      readonly kind: "publish";
      readonly signature: string;
      readonly result: PublishSupervisorTargetsResult;
    }
  | {
      readonly kind: "propose";
      readonly signature: string;
      readonly result: SupervisorMutationProposalResult;
      readonly proposalHandle?: SupervisorProposalHandle;
    }
  | {
      readonly kind: "propose-tombstone";
      readonly result: SupervisorMutationProposalResult;
    };

const DEFAULT_TARGET_TTL_MS = 2 * 60_000;
const DEFAULT_PROPOSAL_TTL_MS = 30_000;
const DEFAULT_MAX_READ_ITEMS = 20;
const DEFAULT_MAX_TEXT_CHARS = 240;
const DEFAULT_MAX_AMBIGUOUS_CANDIDATES = 5;
const DEFAULT_MAX_ALIASES_PER_TARGET = 8;
const DEFAULT_MAX_CALL_ID_CHARS = 160;
const DEFAULT_MAX_OPAQUE_ID_CHARS = 160;
const DEFAULT_MAX_TARGETS = 256;
const DEFAULT_MAX_PROPOSALS = 32;
const DEFAULT_MAX_CALLS = 256;
const DEFAULT_MAX_SNAPSHOT_DEPTH = 16;
const DEFAULT_MAX_SNAPSHOT_NODES = 1_024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 32 * 1024;
const DEFAULT_MAX_SNAPSHOT_KEYS = 1_024;
const DEFAULT_MAX_SNAPSHOT_ARRAY_ITEMS = 256;

function normalizeSelector(value: string): string {
  return value.slice(0, 512).trim().toLowerCase();
}

function normalizeBoundedText(value: string, maxChars: number): string {
  return boundSupervisorText(value.slice(0, maxChars + 1).trim(), maxChars);
}

function boundedExpiry(now: number, ttlMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + ttlMs);
}

function copyTargetBinding(binding: SupervisorTargetBinding): SupervisorTargetBinding {
  return binding.kind === "project"
    ? Object.freeze({
        kind: "project",
        environmentId: binding.environmentId,
        projectId: binding.projectId,
        version: binding.version,
      })
    : Object.freeze({
        kind: "thread",
        environmentId: binding.environmentId,
        projectId: binding.projectId,
        threadId: binding.threadId,
        version: binding.version,
      });
}

function targetBindingKey(binding: SupervisorTargetBinding): string {
  return binding.kind === "project"
    ? JSON.stringify(["project", binding.environmentId, binding.projectId, binding.version])
    : JSON.stringify([
        "thread",
        binding.environmentId,
        binding.projectId,
        binding.threadId,
        binding.version,
      ]);
}

export function createThreadSupervisorCore(
  options: CreateThreadSupervisorCoreOptions,
): ThreadSupervisorCore {
  const targetTtlMs = requirePositiveInteger(
    options.targetTtlMs ?? DEFAULT_TARGET_TTL_MS,
    "targetTtlMs",
  );
  const proposalTtlMs = requirePositiveInteger(
    options.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS,
    "proposalTtlMs",
  );
  const maxReadItems = requirePositiveInteger(
    options.maxReadItems ?? DEFAULT_MAX_READ_ITEMS,
    "maxReadItems",
  );
  const maxTextChars = requirePositiveInteger(
    options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    "maxTextChars",
  );
  const maxAmbiguousCandidates = requirePositiveInteger(
    options.maxAmbiguousCandidates ?? DEFAULT_MAX_AMBIGUOUS_CANDIDATES,
    "maxAmbiguousCandidates",
  );
  const maxAliasesPerTarget = requirePositiveInteger(
    options.maxAliasesPerTarget ?? DEFAULT_MAX_ALIASES_PER_TARGET,
    "maxAliasesPerTarget",
  );
  const maxCallIdChars = requirePositiveInteger(
    options.maxCallIdChars ?? DEFAULT_MAX_CALL_ID_CHARS,
    "maxCallIdChars",
  );
  const maxOpaqueIdChars = requirePositiveInteger(
    options.maxOpaqueIdChars ?? DEFAULT_MAX_OPAQUE_ID_CHARS,
    "maxOpaqueIdChars",
  );
  const maxTargets = requirePositiveInteger(
    options.maxTargets ?? DEFAULT_MAX_TARGETS,
    "maxTargets",
  );
  const maxProposals = requirePositiveInteger(
    options.maxProposals ?? DEFAULT_MAX_PROPOSALS,
    "maxProposals",
  );
  const maxCalls = requirePositiveInteger(options.maxCalls ?? DEFAULT_MAX_CALLS, "maxCalls");
  const snapshotBounds: SupervisorJsonSnapshotBounds = Object.freeze({
    maxDepth: requirePositiveInteger(
      options.maxSnapshotDepth ?? DEFAULT_MAX_SNAPSHOT_DEPTH,
      "maxSnapshotDepth",
    ),
    maxNodes: requirePositiveInteger(
      options.maxSnapshotNodes ?? DEFAULT_MAX_SNAPSHOT_NODES,
      "maxSnapshotNodes",
    ),
    maxBytes: requirePositiveInteger(
      options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
      "maxSnapshotBytes",
    ),
    maxKeys: requirePositiveInteger(
      options.maxSnapshotKeys ?? DEFAULT_MAX_SNAPSHOT_KEYS,
      "maxSnapshotKeys",
    ),
    maxArrayItems: requirePositiveInteger(
      options.maxSnapshotArrayItems ?? DEFAULT_MAX_SNAPSHOT_ARRAY_ITEMS,
      "maxSnapshotArrayItems",
    ),
  });
  const targets = new Map<SupervisorTargetHandle, StoredTarget>();
  const targetHandlesByBinding = new Map<string, SupervisorTargetHandle>();
  const proposals = new Map<SupervisorProposalHandle, StoredProposal>();
  // Bounded but never evicted: once full, every new call ID fails closed while
  // known replay guards remain authoritative for this supervisor session.
  const calls = new Map<string, StoredCall>();
  const latestPublicationByKind = new Map<SupervisorTargetBinding["kind"], number>();
  let pendingProposalHandle: SupervisorProposalHandle | null = null;
  let publicationGeneration = 0;
  let handleSequence = 0;

  const validCallId = (callId: string) =>
    callId.length > 0 && callId.length <= maxCallIdChars && callId.trim() === callId;
  const validRequestedLimit = (requestedLimit: number | undefined) =>
    requestedLimit === undefined || (Number.isSafeInteger(requestedLimit) && requestedLimit >= 0);
  const validOpaqueHandle = (handle: string) =>
    handle.length > 0 && handle.length <= maxOpaqueIdChars + 32 && handle.trim() === handle;
  const validBindingPart = (value: string) =>
    value.length > 0 && value.length <= maxOpaqueIdChars && value.trim() === value;
  const validBinding = (binding: SupervisorTargetBinding) =>
    validBindingPart(binding.environmentId) &&
    validBindingPart(binding.projectId) &&
    validBindingPart(binding.version) &&
    (binding.kind === "project" || validBindingPart(binding.threadId));

  const nextHandle = (
    kind: "target" | "proposal",
  ): { readonly status: "created"; readonly value: string } | { readonly status: "invalid" } => {
    const opaqueId = options.makeOpaqueId(kind);
    if (
      opaqueId.trim().length === 0 ||
      opaqueId.length > maxOpaqueIdChars ||
      opaqueId.trim() !== opaqueId
    ) {
      return { status: "invalid" };
    }
    handleSequence += 1;
    return { status: "created", value: `${kind}_${opaqueId}_${handleSequence}` };
  };

  const prune = (now: number) => {
    const retentionMs = Math.max(targetTtlMs, proposalTtlMs);
    for (const [handle, target] of targets) {
      if (target.expiresAtEpochMs + retentionMs <= now) {
        targets.delete(handle);
        if (targetHandlesByBinding.get(target.bindingKey) === handle) {
          targetHandlesByBinding.delete(target.bindingKey);
        }
      }
    }
    for (const [handle, proposal] of proposals) {
      if (proposal.proposal.expiresAtEpochMs + retentionMs <= now) {
        proposals.delete(handle);
        if (pendingProposalHandle === handle) pendingProposalHandle = null;
      }
    }
  };

  const toResolutionCandidate = (target: StoredTarget): SupervisorTargetResolutionCandidate =>
    Object.freeze({
      handle: target.publicTarget.handle,
      kind: target.publicTarget.kind,
      label: target.publicTarget.label,
      availability: target.publicTarget.availability,
    });

  const normalizeTargets = (
    input: PublishSupervisorTargetsInput,
  ):
    | {
        readonly status: "accepted";
        readonly targets: ReadonlyArray<NormalizedTargetCandidate>;
      }
    | { readonly status: "invalid-target-set" } => {
    if (input.targets.some((candidate) => candidate.binding.kind !== input.targetKind)) {
      return { status: "invalid-target-set" };
    }
    const requestedLimit = input.requestedLimit ?? maxReadItems;
    const limit = Math.min(maxReadItems, requestedLimit);
    const unique = new Map<string, NormalizedTargetCandidate>();
    for (const candidate of input.targets.slice(0, limit)) {
      if (!validBinding(candidate.binding)) {
        return { status: "invalid-target-set" };
      }
      const binding = copyTargetBinding(candidate.binding);
      const bindingKey = targetBindingKey(binding);
      if (unique.has(bindingKey)) continue;
      const aliases: string[] = [];
      const aliasKeys = new Set<string>();
      for (const rawAlias of (candidate.aliases ?? []).slice(0, maxAliasesPerTarget)) {
        const alias = normalizeBoundedText(rawAlias, maxTextChars);
        const aliasKey = normalizeSelector(alias);
        if (alias.length > 0 && !aliasKeys.has(aliasKey)) {
          aliases.push(alias);
          aliasKeys.add(aliasKey);
        }
      }
      unique.set(bindingKey, {
        binding,
        bindingKey,
        label: normalizeBoundedText(candidate.label, maxTextChars),
        aliases: Object.freeze(aliases),
        availability: candidate.availability,
      });
    }
    return { status: "accepted", targets: Object.freeze([...unique.values()]) };
  };

  const publishSignature = (
    normalized: ReadonlyArray<NormalizedTargetCandidate>,
    totalCount: number,
  ) =>
    JSON.stringify({
      totalCount,
      targets: normalized.map((target) => ({
        bindingKey: target.bindingKey,
        label: target.label,
        aliases: target.aliases,
        availability: target.availability,
      })),
    });

  const resolveTarget = (
    selector: string,
    expectedKind: SupervisorTargetBinding["kind"],
  ): SupervisorTargetResolution => {
    const now = options.now();
    prune(now);
    const direct = targets.get(selector as SupervisorTargetHandle);
    if (direct !== undefined) {
      if (direct.expiresAtEpochMs <= now) return { status: "expired" };
      return direct.binding.kind === expectedKind
        ? { status: "resolved", target: toResolutionCandidate(direct) }
        : { status: "not-found" };
    }
    const normalized = normalizeSelector(selector);
    if (normalized.length === 0) return { status: "not-found" };
    const latestGeneration = latestPublicationByKind.get(expectedKind);
    if (latestGeneration === undefined) return { status: "not-found" };
    const currentTargets = [...targets.values()].filter(
      (target) =>
        target.expiresAtEpochMs > now &&
        target.binding.kind === expectedKind &&
        target.publicationGeneration === latestGeneration,
    );
    const exact = currentTargets.filter((target) =>
      [target.publicTarget.label, ...target.aliases].some(
        (label) => normalizeSelector(label) === normalized,
      ),
    );
    if (exact.length === 1) {
      return { status: "resolved", target: toResolutionCandidate(exact[0]!) };
    }
    if (exact.length > 1) {
      return {
        status: "ambiguous",
        candidates: Object.freeze(
          exact.slice(0, maxAmbiguousCandidates).map(toResolutionCandidate),
        ),
      };
    }
    const partial = currentTargets.filter((target) =>
      [target.publicTarget.label, ...target.aliases].some((label) =>
        normalizeSelector(label).includes(normalized),
      ),
    );
    return partial.length === 0
      ? { status: "not-found" }
      : {
          status: "candidates",
          candidates: Object.freeze(
            partial.slice(0, maxAmbiguousCandidates).map(toResolutionCandidate),
          ),
        };
  };

  const publishTargets = (input: PublishSupervisorTargetsInput): PublishSupervisorTargetsResult => {
    const now = options.now();
    prune(now);
    if (!validCallId(input.callId)) return { status: "invalid-call-id" };
    if (!validRequestedLimit(input.requestedLimit)) return { status: "invalid-limit" };
    const existingCall = calls.get(input.callId);
    if (existingCall === undefined && calls.size >= maxCalls) {
      return { status: "capacity-exceeded", resource: "calls" };
    }
    const normalizedResult = normalizeTargets(input);
    if (normalizedResult.status === "invalid-target-set") return normalizedResult;
    const normalized = normalizedResult.targets;
    const signature = JSON.stringify({
      targetKind: input.targetKind,
      targets: publishSignature(normalized, input.targets.length),
    });
    if (existingCall !== undefined) {
      return existingCall.kind === "publish" && existingCall.signature === signature
        ? existingCall.result
        : { status: "call-id-conflict" };
    }

    const reusableHandles = new Map<string, SupervisorTargetHandle>();
    let additions = 0;
    for (const candidate of normalized) {
      const existingHandle = targetHandlesByBinding.get(candidate.bindingKey);
      const existingTarget = existingHandle === undefined ? undefined : targets.get(existingHandle);
      if (
        existingHandle !== undefined &&
        existingTarget !== undefined &&
        existingTarget.expiresAtEpochMs > now
      ) {
        reusableHandles.set(candidate.bindingKey, existingHandle);
      } else {
        additions += 1;
      }
    }
    let result: PublishSupervisorTargetsResult;
    if (targets.size + additions > maxTargets) {
      result = { status: "capacity-exceeded", resource: "targets" };
    } else {
      const newHandles = new Map<string, SupervisorTargetHandle>();
      for (const candidate of normalized) {
        if (reusableHandles.has(candidate.bindingKey)) continue;
        const created = nextHandle("target");
        if (created.status === "invalid") {
          result = { status: "invalid-opaque-id" };
          calls.set(input.callId, { kind: "publish", signature, result });
          return result;
        }
        newHandles.set(candidate.bindingKey, created.value as SupervisorTargetHandle);
      }
      publicationGeneration += 1;
      latestPublicationByKind.set(input.targetKind, publicationGeneration);
      const expiresAtEpochMs = boundedExpiry(now, targetTtlMs);
      const published: PublishedSupervisorTarget[] = [];
      for (const candidate of normalized) {
        const handle =
          reusableHandles.get(candidate.bindingKey) ?? newHandles.get(candidate.bindingKey);
        if (handle === undefined) continue;
        const publicTarget = Object.freeze({
          handle,
          kind: candidate.binding.kind,
          label: candidate.label,
          availability: candidate.availability,
          expiresAtEpochMs,
        });
        targets.set(handle, {
          binding: candidate.binding,
          bindingKey: candidate.bindingKey,
          publicTarget,
          aliases: candidate.aliases,
          expiresAtEpochMs,
          publicationGeneration,
        });
        targetHandlesByBinding.set(candidate.bindingKey, handle);
        published.push(publicTarget);
      }
      const omittedCount = Math.max(0, input.targets.length - published.length);
      result = Object.freeze({
        status: "published",
        result: Object.freeze({
          items: Object.freeze(published),
          totalCount: input.targets.length,
          omittedCount,
          truncated: omittedCount > 0,
        }),
      });
    }
    calls.set(input.callId, { kind: "publish", signature, result });
    return result;
  };

  const refreshPendingProposal = (now: number) => {
    if (pendingProposalHandle === null) return;
    const pending = proposals.get(pendingProposalHandle);
    if (pending === undefined || pending.state !== "pending") {
      pendingProposalHandle = null;
    } else if (pending.proposal.expiresAtEpochMs <= now) {
      pending.state = "expired";
      pendingProposalHandle = null;
    }
  };

  const replayProposalCall = (
    call: Extract<StoredCall, { readonly kind: "propose" }>,
  ): SupervisorMutationProposalResult => {
    if (call.proposalHandle === undefined) return call.result;
    const proposal = proposals.get(call.proposalHandle);
    return proposal === undefined || proposal.state === "expired"
      ? { status: "proposal-expired" }
      : call.result;
  };

  const recordProposalValidationTombstone = (
    callId: string,
    existingCall: StoredCall | undefined,
    result: SupervisorMutationProposalResult,
  ): SupervisorMutationProposalResult => {
    if (existingCall !== undefined) return { status: "call-id-conflict" };
    calls.set(callId, { kind: "propose-tombstone", result });
    return result;
  };

  const proposeMutation = (
    input: ProposeSupervisorMutationInput,
  ): SupervisorMutationProposalResult => {
    const now = options.now();
    prune(now);
    refreshPendingProposal(now);
    if (!validCallId(input.callId)) return { status: "invalid-call-id" };
    const existingCall = calls.get(input.callId);
    if (existingCall === undefined && calls.size >= maxCalls) {
      return { status: "capacity-exceeded", resource: "calls" };
    }
    if (existingCall?.kind === "propose-tombstone") {
      return { status: "call-id-conflict" };
    }
    if (!validOpaqueHandle(input.targetHandle)) {
      return recordProposalValidationTombstone(input.callId, existingCall, {
        status: "invalid-opaque-id",
      });
    }
    if (
      input.replacePendingProposal !== undefined &&
      !validOpaqueHandle(input.replacePendingProposal)
    ) {
      return recordProposalValidationTombstone(input.callId, existingCall, {
        status: "invalid-opaque-id",
      });
    }
    const mutation = createSupervisorJsonSnapshot(input.mutation, snapshotBounds);
    if (mutation.status === "rejected") {
      return recordProposalValidationTombstone(input.callId, existingCall, {
        status: "invalid-snapshot",
        field: "mutation",
        reason: mutation.reason,
      });
    }
    const preview = createSupervisorJsonSnapshot(input.preview, snapshotBounds);
    if (preview.status === "rejected") {
      return recordProposalValidationTombstone(input.callId, existingCall, {
        status: "invalid-snapshot",
        field: "preview",
        reason: preview.reason,
      });
    }
    const action = normalizeBoundedText(input.action, maxTextChars);
    const summary = normalizeBoundedText(input.summary, maxTextChars);
    const signature = JSON.stringify({
      targetHandle: input.targetHandle,
      expectedTargetKind: input.expectedTargetKind,
      action,
      summary,
      mutation: mutation.signature,
      preview: preview.signature,
      replacePendingProposal: input.replacePendingProposal ?? null,
    });
    if (existingCall !== undefined) {
      return existingCall.kind === "propose" && existingCall.signature === signature
        ? replayProposalCall(existingCall)
        : { status: "call-id-conflict" };
    }

    const target = targets.get(input.targetHandle as SupervisorTargetHandle);
    let result: SupervisorMutationProposalResult;
    let proposalHandle: SupervisorProposalHandle | undefined;
    if (target === undefined || target.binding.kind !== input.expectedTargetKind) {
      result = { status: "not-found" };
    } else if (target.expiresAtEpochMs <= now) {
      result = { status: "target-expired" };
    } else if (target.publicTarget.availability !== "live") {
      result = { status: "target-unavailable", availability: target.publicTarget.availability };
    } else {
      const pending =
        pendingProposalHandle === null ? undefined : proposals.get(pendingProposalHandle);
      if (pending !== undefined && input.replacePendingProposal !== pending.proposal.handle) {
        result = { status: "pending-proposal", proposal: pending.proposal };
      } else if (pending === undefined && input.replacePendingProposal !== undefined) {
        result = { status: "replacement-mismatch" };
      } else if (proposals.size >= maxProposals) {
        result = { status: "capacity-exceeded", resource: "proposals" };
      } else {
        const created = nextHandle("proposal");
        if (created.status === "invalid") {
          result = { status: "invalid-opaque-id" };
        } else {
          proposalHandle = created.value as SupervisorProposalHandle;
          const proposal = Object.freeze({
            handle: proposalHandle,
            action,
            summary,
            target: toResolutionCandidate(target),
            expiresAtEpochMs: Math.min(boundedExpiry(now, proposalTtlMs), target.expiresAtEpochMs),
          });
          const confirmationPayload = Object.freeze({
            proposal,
            target: target.binding,
            preview: preview.value,
          });
          proposals.set(proposalHandle, {
            proposal,
            target,
            mutation: mutation.value,
            confirmationPayload,
            state: "pending",
          });
          pendingProposalHandle = proposalHandle;
          if (pending !== undefined) {
            pending.state = "replaced";
            pending.replacementHandle = proposalHandle;
          }
          result = Object.freeze({
            status: "proposed",
            proposal,
            ...(pending === undefined ? {} : { replacedProposalHandle: pending.proposal.handle }),
          });
        }
      }
    }
    calls.set(input.callId, {
      kind: "propose",
      signature,
      result,
      ...(proposalHandle === undefined ? {} : { proposalHandle }),
    });
    return result;
  };

  const getConfirmationPayloadLocally = (
    handle: SupervisorProposalHandle,
  ): SupervisorLocalConfirmationState => {
    const now = options.now();
    prune(now);
    refreshPendingProposal(now);
    const stored = proposals.get(handle);
    if (stored === undefined) return { status: "proposal-not-found" };
    if (stored.state === "pending" || stored.state === "executing") {
      return { status: stored.state, payload: stored.confirmationPayload };
    }
    if (stored.state === "replaced") {
      return stored.replacementHandle === undefined
        ? { status: "settled" }
        : { status: "replaced", replacementHandle: stored.replacementHandle };
    }
    return { status: stored.state };
  };

  const cancelProposalLocally = (
    handle: SupervisorProposalHandle,
  ): CancelSupervisorProposalResult => {
    const now = options.now();
    prune(now);
    refreshPendingProposal(now);
    const stored = proposals.get(handle);
    if (stored === undefined) return { status: "proposal-not-found" };
    if (stored.state !== "pending") return { status: "not-pending", state: stored.state };
    stored.state = "cancelled";
    if (pendingProposalHandle === handle) pendingProposalHandle = null;
    return { status: "cancelled" };
  };

  const confirmProposalLocally = (
    handle: SupervisorProposalHandle,
    adapter: SupervisorMutationExecutionAdapter,
  ): Promise<SupervisorConfirmedMutationResult> => {
    const now = options.now();
    prune(now);
    const stored = proposals.get(handle);
    if (stored === undefined) return Promise.resolve({ status: "proposal-not-found" });
    if (stored.execution !== undefined) return stored.execution;
    if (stored.state === "cancelled") return Promise.resolve({ status: "cancelled" });
    if (stored.state === "replaced") {
      return Promise.resolve(
        stored.replacementHandle === undefined
          ? { status: "proposal-not-found" }
          : { status: "replaced", replacementHandle: stored.replacementHandle },
      );
    }
    if (stored.state === "expired" || stored.proposal.expiresAtEpochMs <= now) {
      stored.state = "expired";
      if (pendingProposalHandle === handle) pendingProposalHandle = null;
      const expired = Promise.resolve({ status: "expired" } as const);
      stored.execution = expired;
      return expired;
    }
    if (stored.state !== "pending") return Promise.resolve({ status: "proposal-not-found" });
    stored.state = "executing";
    if (pendingProposalHandle === handle) pendingProposalHandle = null;
    const execution = Promise.resolve()
      .then(() =>
        adapter.executeConfirmed({ target: stored.target.binding, mutation: stored.mutation }),
      )
      .then((adapterResult): SupervisorConfirmedMutationResult => {
        stored.state = "settled";
        if (adapterResult.status === "rejected") {
          return Object.freeze({ status: "target-rejected", reason: adapterResult.reason });
        }
        const value = createSupervisorJsonSnapshot(adapterResult.value, snapshotBounds);
        return value.status === "accepted"
          ? Object.freeze({ status: "executed", value: value.value })
          : Object.freeze({ status: "execution-result-invalid", reason: value.reason });
      })
      .catch((): SupervisorConfirmedMutationResult => {
        stored.state = "settled";
        return Object.freeze({ status: "execution-failed" });
      });
    // Defer adapter invocation until after the one shared promise is installed.
    stored.execution = execution;
    return execution;
  };

  return {
    publishTargets,
    resolveTarget,
    proposeMutation,
    getConfirmationPayloadLocally,
    cancelProposalLocally,
    confirmProposalLocally,
  };
}
