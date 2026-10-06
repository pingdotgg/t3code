// @effect-diagnostics nodeBuiltinImport:off
import type { ProviderRequestKind, RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Runtime-policy decisions for ACP work that T3 mediates.
 *
 * ACP agents run their own tools under their own permission model and ask
 * through `session/request_permission`, which T3 answers by policy. The one
 * client-mediated path left is Devin's `terminal/*`, which runs with the T3
 * server's own privileges; it resolves through {@link acpOperationDisposition}
 * so a client terminal can never do more than an execute permission request.
 */

/** Structural subset of the adapter runtime policy that decisions read. */
export interface AcpRuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}

export type AcpPermissionDisposition = "allow" | "ask" | "deny";

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveAcpPermissionPath(path: string, cwd: string | null): string | undefined {
  const trimmed = path.trim();
  if (trimmed.length === 0) return undefined;
  if (NodePath.isAbsolute(trimmed)) return trimmed;
  if (cwd === null || cwd.trim().length === 0) return undefined;
  return `${cwd}${cwd.endsWith(NodePath.sep) ? "" : NodePath.sep}${trimmed}`;
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

/**
 * Canonicalize a path for an authorization containment check.
 *
 * `realpath` cannot resolve a file that has not been created yet, so walk up
 * to the deepest existing ancestor and append the missing suffix to that
 * ancestor's canonical path. This follows symlinked directories while still
 * allowing normal writes to new files. If an existing entry cannot be
 * canonicalized (for example, a broken symlink), fail closed.
 */
function acpCanonicalPathForContainment(path: string): string | undefined {
  // Do not lexically normalize before realpath. For a path such as
  // `workspace/link/../file`, the kernel resolves `link` before `..`; an
  // eager NodePath.resolve would erase that symlink traversal and could turn
  // an outside target into an apparently in-workspace path.
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
      // The entry exists but realpath could not resolve it, as with a broken
      // symlink. Treat it as untrusted rather than authorizing its lexical path.
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

/** The parts of a native operation the disposition logic reads. */
interface AcpPolicyOperation {
  readonly kind: string | null | undefined;
  readonly locations: ReadonlyArray<{ readonly path: string }> | null | undefined;
}

function acpPolicyRequiresApproval(runtimePolicy: AcpRuntimePolicy): boolean {
  return runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "approval-required"
    : runtimePolicy.approvalPolicy !== "never";
}

function isAcpReadKind(toolKind: string): boolean {
  return toolKind === "read" || toolKind === "search" || toolKind === "think";
}

/**
 * Reads follow the sandbox alone and never ask. Approval policy governs writes
 * and commands, as it does for Codex and Claude, and every sandbox T3 knows
 * lets the agent read. That includes no explicit sandbox, since the strictest
 * runtime mode (approval-required) implies a read-only one. Unknown sandbox
 * types still fail closed.
 */
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

function acpWorkspaceWriteAllowsMutation(
  runtimePolicy: AcpRuntimePolicy,
  sandboxPolicy: Record<string, unknown>,
  locations: AcpPolicyOperation["locations"],
): boolean {
  const cwd =
    typeof runtimePolicy.cwd === "string" && runtimePolicy.cwd.trim().length > 0
      ? (resolveAcpPermissionPath(runtimePolicy.cwd, process.cwd()) ?? null)
      : null;
  const roots: Array<string> = [];
  if (cwd !== null) {
    const canonicalCwd = acpCanonicalPathForContainment(cwd);
    if (canonicalCwd !== undefined) roots.push(canonicalCwd);
  }
  const writableRoots = sandboxPolicy.writableRoots;
  if (Array.isArray(writableRoots)) {
    for (const writableRoot of writableRoots) {
      if (typeof writableRoot !== "string") continue;
      const resolved = resolveAcpPermissionPath(writableRoot, cwd);
      if (resolved === undefined) continue;
      const canonicalRoot = acpCanonicalPathForContainment(resolved);
      if (canonicalRoot !== undefined) roots.push(canonicalRoot);
    }
  }
  if (roots.length === 0) return false;

  if (locations === undefined || locations === null || locations.length === 0) {
    return false;
  }
  for (const location of locations) {
    const resolved = resolveAcpPermissionPath(location.path, cwd);
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

/**
 * Disposition of one native operation under the active runtime policy. Shared
 * by provider permission requests and the client fs/terminal handlers.
 */
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
        return acpWorkspaceWriteAllowsMutation(
          runtimePolicy,
          sandboxPolicy ?? {},
          operation.locations,
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
      // Auto-accept edits approves file changes wherever the agent makes them
      // (ACP prompts need not carry locations to confine); other actions still ask.
      if (
        runtimePolicy.runtimeMode === "auto-accept-edits" &&
        runtimePolicy.approvalPolicy === undefined &&
        !isAcpMutationKind(toolKind)
      ) {
        return "ask";
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
    locations: request.toolCall.locations,
  });
}

/** Resolve explicitly tagged MCP approvals through the thread's normal policy. */
export function acpMcpToolApprovalElicitationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.CreateElicitationRequest,
  nativeRequestId?: string,
): AcpPermissionDisposition | undefined {
  if (
    request.mode !== "form" ||
    (unknownRecord(request._meta)?.codex_approval_kind !== "mcp_tool_call" &&
      nativeRequestId?.startsWith("mcp_tool_call_approval_") !== true)
  ) {
    return undefined;
  }
  // This request comes from T3's authenticated, scope-checked MCP endpoint,
  // not an arbitrary provider command. Let explicit approval mode surface it
  // to the user and otherwise allow the endpoint to enforce its own policy.
  return acpPolicyRequiresApproval(runtimePolicy) ? "ask" : "allow";
}

/** Disposition of a client-mediated `terminal/create` (Devin's client terminals). */
export function acpClientExecuteDisposition(
  runtimePolicy: AcpRuntimePolicy,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "execute", locations: undefined });
}

export interface AcpApprovalGrantInput {
  readonly kind: ProviderRequestKind;
  readonly scope: "session" | "turn";
  readonly turnKey: string;
}

export interface AcpClientPolicyGrants {
  readonly recordApproval: (input: AcpApprovalGrantInput) => void;
  readonly allowsExecute: (turnKey: string | null) => boolean;
}

/**
 * Command approvals recorded when the user accepts a `session/request_permission`,
 * so an "ask" disposition at the client terminal boundary honors a command the
 * user already approved. ACP does not link an approved tool call to the
 * terminals the agent then creates, so an approved command authorizes client
 * terminals for the approving turn, or for the session on accept-for-session.
 */
export function makeAcpClientPolicyGrants(): AcpClientPolicyGrants {
  let sessionExecute = false;
  let turnExecute: string | null = null;
  return {
    recordApproval: (input) => {
      if (input.kind !== "command") return;
      if (input.scope === "session") {
        sessionExecute = true;
      } else {
        turnExecute = input.turnKey;
      }
    },
    allowsExecute: (turnKey) => sessionExecute || (turnKey !== null && turnExecute === turnKey),
  };
}
