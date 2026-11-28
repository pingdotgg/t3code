// @effect-diagnostics nodeBuiltinImport:off
import type { RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface AcpRuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
  readonly workspace?: { readonly extraRoots: ReadonlyArray<string> } | undefined;
}

export type AcpPermissionDisposition = "allow" | "ask" | "deny";

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// The path is joined and resolved exactly as written; only the operating system may read it differently.
function resolveAcpPermissionPath(path: string, cwd: string | null): string | undefined {
  if (path.trim().length === 0) return undefined;
  if (NodePath.isAbsolute(path)) return path;
  if (cwd === null || cwd.trim().length === 0) return undefined;
  return `${cwd}${cwd.endsWith(NodePath.sep) ? "" : NodePath.sep}${path}`;
}

function acpPathIsWithinRoot(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

// Canonicalize existing ancestors for symlink-aware checks of new paths; fail closed on errors.
function acpCanonicalPathForContainment(path: string): string | undefined {
  // realpath must resolve symlinks before ..; lexical normalization can hide traversal.
  let candidate = path;
  const missingSuffix: Array<string> = [];

  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    const parent = NodePath.dirname(candidate);
    if (parent === candidate) return undefined;
    missingSuffix.unshift(NodePath.basename(candidate));
    candidate = parent;
  }
}

/**
 * Every path a file change touches, each exactly as the agent sent it, or "unknown" when any
 * part of the change could not be read. An unknown change is never approved by a folder check.
 */
export type AcpChangedPaths = ReadonlyArray<string> | "unknown";

/** A change that names more paths than this is treated as unknown rather than resolved one by one. */
const MAX_ACP_CHANGED_PATHS = 256;

/**
 * The path as given when policy can resolve it the way the agent will. Blank strings, non-strings
 * and NUL bytes name no file. A relative path that starts with `~`, has a URL scheme or drive
 * prefix, or uses backslashes on a POSIX host may mean another file to the agent than it does
 * when joined to the working directory.
 */
function acpCheckablePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    return undefined;
  }
  if (NodePath.isAbsolute(value)) return value;
  if (value.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return undefined;
  if (NodePath.sep === "/" && value.includes("\\")) return undefined;
  return value;
}

/** Both sets together; unknown stays unknown. */
export function mergeAcpChangedPaths(
  left: AcpChangedPaths | undefined,
  right: AcpChangedPaths | undefined,
): AcpChangedPaths {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === undefined || left.length === 0) return right ?? [];
  if (right === undefined || right.length === 0) return left;
  const merged = [...new Set([...left, ...right])];
  return merged.length > MAX_ACP_CHANGED_PATHS ? "unknown" : merged;
}

/** The keys of a tool call's raw input that name a file it changes. */
export const ACP_RAW_INPUT_PATH_KEYS = ["path", "filePath", "file_path"] as const;

/**
 * The one reading of which files a tool call changes, for a permission request and for every
 * notification of the call it names: its locations, its diffs and the path keys of its raw input.
 * A part without a checkable path, or of a kind this client does not know, makes it all unknown.
 */
export function acpChangedPathsOfToolCall(toolCall: {
  readonly locations?: unknown;
  readonly content?: unknown;
  readonly rawInput?: unknown;
}): AcpChangedPaths {
  const paths = new Set<string>();
  let complete = true;
  const requirePath = (value: unknown) => {
    const path = acpCheckablePath(value);
    if (path === undefined) complete = false;
    else paths.add(path);
  };
  const { locations, content, rawInput } = toolCall;
  if (Array.isArray(locations)) {
    for (const location of locations) requirePath(unknownRecord(location)?.path);
  } else if (locations !== undefined && locations !== null) {
    complete = false;
  }
  if (Array.isArray(content)) {
    for (const value of content) {
      const entry = unknownRecord(value);
      if (entry?.type === "content" || entry?.type === "terminal") continue;
      if (entry?.type !== "diff") {
        complete = false;
        continue;
      }
      if (entry.changes === undefined || entry.changes === null) {
        requirePath(entry.path);
        continue;
      }
      if (!Array.isArray(entry.changes)) {
        complete = false;
        continue;
      }
      if (entry.path !== undefined && entry.path !== null) requirePath(entry.path);
      for (const value of entry.changes) {
        const change = unknownRecord(value);
        switch (change?.operation) {
          case "move":
            requirePath(change.oldPath);
            requirePath(change.path);
            break;
          case "add":
          case "delete":
          case "modify":
          // A copy only reads its source.
          case "copy":
            requirePath(change.path);
            break;
          default:
            // An operation this client does not know may write where its fields do not show.
            complete = false;
        }
      }
    }
  } else if (content !== undefined && content !== null) {
    complete = false;
  }
  const input = unknownRecord(rawInput);
  if (input !== undefined) {
    for (const key of ACP_RAW_INPUT_PATH_KEYS) {
      const value = input[key];
      if (value !== undefined && value !== null) requirePath(value);
    }
  }
  return complete && paths.size <= MAX_ACP_CHANGED_PATHS ? [...paths] : "unknown";
}

interface AcpPolicyOperation {
  readonly kind: string | null | undefined;
  readonly changedPaths: AcpChangedPaths;
}

function acpPolicyRequiresApproval(runtimePolicy: AcpRuntimePolicy): boolean {
  return runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "approval-required"
    : runtimePolicy.approvalPolicy !== "never";
}

function isAcpReadKind(toolKind: string): boolean {
  return toolKind === "read" || toolKind === "search" || toolKind === "think";
}

/** Reads never ask; an absent sandbox implies read-only in approval-required mode. */
function acpReadDisposition(runtimePolicy: AcpRuntimePolicy): "allow" | "deny" {
  switch (unknownRecord(runtimePolicy.sandboxPolicy)?.type) {
    case undefined:
    case "readOnly":
    case "workspaceWrite":
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    default:
      return "deny";
  }
}

/** True when the change names at least one path and every path is inside `cwd`, a sandbox writable root or one of the thread's other folders. */
function acpMutationStaysInWorkspace(
  runtimePolicy: AcpRuntimePolicy,
  sandboxPolicy: Record<string, unknown>,
  changedPaths: AcpChangedPaths,
): boolean {
  if (changedPaths === "unknown" || changedPaths.length === 0) return false;
  const cwd =
    typeof runtimePolicy.cwd === "string" && runtimePolicy.cwd.trim().length > 0
      ? (resolveAcpPermissionPath(runtimePolicy.cwd, process.cwd()) ?? null)
      : null;
  const roots: Array<string> = [];
  if (cwd !== null) {
    const canonicalCwd = acpCanonicalPathForContainment(cwd);
    if (canonicalCwd !== undefined) roots.push(canonicalCwd);
  }
  const writableRoots = [
    ...(Array.isArray(sandboxPolicy.writableRoots) ? sandboxPolicy.writableRoots : []),
    ...(runtimePolicy.workspace?.extraRoots ?? []),
  ];
  for (const writableRoot of writableRoots) {
    if (typeof writableRoot !== "string") continue;
    const resolved = resolveAcpPermissionPath(writableRoot, cwd);
    if (resolved === undefined) continue;
    const canonicalRoot = acpCanonicalPathForContainment(resolved);
    if (canonicalRoot !== undefined) roots.push(canonicalRoot);
  }
  if (roots.length === 0) return false;

  for (const changedPath of changedPaths) {
    const resolved = resolveAcpPermissionPath(changedPath, cwd);
    const canonicalPath =
      resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
    if (
      canonicalPath === undefined ||
      !roots.some((root) => acpPathIsWithinRoot(canonicalPath, root))
    ) {
      return false;
    }
  }
  return true;
}

function acpOperationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  operation: AcpPolicyOperation,
): AcpPermissionDisposition {
  const toolKind = operation.kind ?? "other";
  if (isAcpReadKind(toolKind)) {
    return acpReadDisposition(runtimePolicy);
  }
  if (acpPolicyRequiresApproval(runtimePolicy)) {
    return "ask";
  }

  const sandboxPolicy = unknownRecord(runtimePolicy.sandboxPolicy);
  switch (sandboxPolicy?.type) {
    case "readOnly":
      return "deny";
    case "workspaceWrite":
      if (isAcpMutationKind(toolKind)) {
        return acpMutationStaysInWorkspace(
          runtimePolicy,
          sandboxPolicy ?? {},
          operation.changedPaths,
        )
          ? "allow"
          : "deny";
      }
      return "deny";
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    case undefined:
      if (runtimePolicy.runtimeMode === "approval-required") return "deny";
      if (
        runtimePolicy.runtimeMode === "auto-accept-edits" &&
        runtimePolicy.approvalPolicy === undefined
      ) {
        // Auto-accept covers file changes in the thread's own folders; the user decides the rest.
        return isAcpMutationKind(toolKind) &&
          acpMutationStaysInWorkspace(runtimePolicy, {}, operation.changedPaths)
          ? "allow"
          : "ask";
      }
      return "allow";
    default:
      return "deny";
  }
}

function isAcpMutationKind(toolKind: string): boolean {
  return toolKind === "edit" || toolKind === "delete" || toolKind === "move";
}

export function acpPermissionDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, {
    kind: request.toolCall.kind,
    changedPaths: acpChangedPathsOfToolCall(request.toolCall),
  });
}

export function acpMcpToolApprovalElicitationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.CreateElicitationRequest,
  nativeRequestId?: string,
): "ask" | "allow" | undefined {
  if (
    request.mode !== "form" ||
    (unknownRecord(request._meta)?.codex_approval_kind !== "mcp_tool_call" &&
      nativeRequestId?.startsWith("mcp_tool_call_approval_") !== true)
  ) {
    return undefined;
  }
  // T3's authenticated MCP endpoint enforces scope; only explicit approval mode needs a user prompt.
  return acpPolicyRequiresApproval(runtimePolicy) ? "ask" : "allow";
}

export function acpClientExecuteDisposition(
  runtimePolicy: AcpRuntimePolicy,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "execute", changedPaths: [] });
}

export interface AcpApprovalGrantInput {
  /** The approved request's ACP tool kind, after ID-only requests take their tracked call's kind. */
  readonly toolKind: string;
  readonly scope: "session" | "turn";
  readonly turnKey: string;
}

export interface AcpClientPolicyGrants {
  readonly recordApproval: (input: AcpApprovalGrantInput) => void;
  readonly allowsExecute: (turnKey: string | null) => boolean;
}

/** ACP cannot link commands to terminals; approved execute requests grant execution for the turn or accepted session. */
export function makeAcpClientPolicyGrants(): AcpClientPolicyGrants {
  let sessionExecute = false;
  let turnExecute: string | null = null;
  return {
    recordApproval: (input) => {
      // Other kinds also show as command cards, but approving them must not open terminals.
      if (input.toolKind !== "execute") return;
      if (input.scope === "session") {
        sessionExecute = true;
      } else {
        turnExecute = input.turnKey;
      }
    },
    allowsExecute: (turnKey) => sessionExecute || (turnKey !== null && turnExecute === turnKey),
  };
}
