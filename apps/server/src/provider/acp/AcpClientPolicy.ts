// @effect-diagnostics nodeBuiltinImport:off
import type { ProviderRequestKind, RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Runtime-policy decisions for ACP work that T3 mediates.
 *
 * ACP agents touch the machine two ways: provider-owned execution inside the
 * agent process, which T3 can only gate through `session/request_permission`,
 * and client-mediated `fs/*` and `terminal/*` requests, which run with the T3
 * server's own privileges. Both paths resolve through
 * {@link acpOperationDisposition} so a client-mediated request can never do
 * more than the equivalent permission request would be allowed to do.
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

export function resolveAcpPermissionPath(path: string, cwd: string | null): string | undefined {
  const trimmed = path.trim();
  if (trimmed.length === 0) return undefined;
  if (NodePath.isAbsolute(trimmed)) return trimmed;
  if (cwd === null || cwd.trim().length === 0) return undefined;
  return `${cwd}${cwd.endsWith(NodePath.sep) ? "" : NodePath.sep}${trimmed}`;
}

export function acpPathIsWithinRoot(path: string, root: string): boolean {
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
export function acpCanonicalPathForContainment(path: string): string | undefined {
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
export function acpOperationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  operation: AcpPolicyOperation,
): AcpPermissionDisposition {
  if (acpPolicyRequiresApproval(runtimePolicy)) {
    return "ask";
  }

  const sandboxPolicy = unknownRecord(runtimePolicy.sandboxPolicy);
  const sandboxType = sandboxPolicy?.type;
  const toolKind = operation.kind ?? "other";
  switch (sandboxType) {
    case "readOnly":
      return toolKind === "read" || toolKind === "search" || toolKind === "think"
        ? "allow"
        : "deny";
    case "workspaceWrite":
      if (toolKind === "read" || toolKind === "search" || toolKind === "think") {
        return "allow";
      }
      if (toolKind === "edit" || toolKind === "delete" || toolKind === "move") {
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
      return runtimePolicy.runtimeMode === "approval-required" ? "deny" : "allow";
    default:
      return "deny";
  }
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

/** Disposition of a client-mediated `fs/write_text_file` to one path. */
export function acpClientWriteDisposition(
  runtimePolicy: AcpRuntimePolicy,
  path: string,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "edit", locations: [{ path }] });
}

/** Disposition of a client-mediated `fs/read_text_file` from one path. */
export function acpClientReadDisposition(
  runtimePolicy: AcpRuntimePolicy,
  path: string,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "read", locations: [{ path }] });
}

/** Disposition of a client-mediated `terminal/create`. */
export function acpClientExecuteDisposition(
  runtimePolicy: AcpRuntimePolicy,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "execute", locations: undefined });
}

const MAX_GRANTED_WRITE_ROOTS = 128;

export interface AcpApprovalGrantInput {
  readonly kind: ProviderRequestKind;
  readonly locations: ReadonlyArray<string>;
  readonly cwd: string | null;
  readonly scope: "session" | "turn";
  readonly turnKey: string;
}

export interface AcpClientPolicyGrants {
  readonly recordApproval: (input: AcpApprovalGrantInput) => void;
  readonly allowsRead: (input: {
    readonly path: string;
    readonly cwd: string | null;
    readonly turnKey: string | null;
  }) => boolean;
  readonly allowsWrite: (input: {
    readonly path: string;
    readonly cwd: string | null;
    readonly turnKey: string | null;
  }) => boolean;
  readonly allowsExecute: (turnKey: string | null) => boolean;
}

/**
 * Approval grants recorded when the user accepts a `session/request_permission`,
 * so an "ask" disposition at the client fs/terminal boundary can honor what the
 * user already approved.
 *
 * ACP carries no linkage between an approved tool call and the client-mediated
 * requests the agent issues to carry it out, so grants are scoped as tightly as
 * the protocol allows: an accepted file change authorizes client writes to its
 * canonical reported locations (or the whole scope when the agent reported
 * none), an accepted file read does the same for reads, and an accepted command
 * authorizes client terminals. Grants last for the approving turn, or for the
 * session on accept-for-session.
 */
export function makeAcpClientPolicyGrants(): AcpClientPolicyGrants {
  interface ScopeGrants {
    execute: boolean;
    unscopedRead: boolean;
    unscopedWrite: boolean;
    readRoots: Array<string>;
    writeRoots: Array<string>;
  }
  const emptyScope = (): ScopeGrants => ({
    execute: false,
    unscopedRead: false,
    unscopedWrite: false,
    readRoots: [],
    writeRoots: [],
  });
  const session = emptyScope();
  let turn: { readonly key: string; readonly grants: ScopeGrants } | null = null;

  const scopeFor = (input: AcpApprovalGrantInput): ScopeGrants => {
    if (input.scope === "session") return session;
    if (turn === null || turn.key !== input.turnKey) {
      turn = { key: input.turnKey, grants: emptyScope() };
    }
    return turn.grants;
  };

  const activeScopes = (turnKey: string | null): Array<ScopeGrants> =>
    turn !== null && turnKey !== null && turn.key === turnKey ? [session, turn.grants] : [session];

  const recordPathGrant = (roots: Array<string>, input: AcpApprovalGrantInput): void => {
    for (const location of input.locations) {
      const resolved = resolveAcpPermissionPath(location, input.cwd);
      const canonical =
        resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
      if (canonical === undefined) continue;
      roots.push(canonical);
      if (roots.length > MAX_GRANTED_WRITE_ROOTS) roots.shift();
    }
  };

  const allowsPath = (input: {
    readonly path: string;
    readonly cwd: string | null;
    readonly turnKey: string | null;
    readonly unscoped: keyof Pick<ScopeGrants, "unscopedRead" | "unscopedWrite">;
    readonly roots: keyof Pick<ScopeGrants, "readRoots" | "writeRoots">;
  }): boolean => {
    const scopes = activeScopes(input.turnKey);
    if (scopes.some((scope) => scope[input.unscoped])) return true;
    const resolved = resolveAcpPermissionPath(input.path, input.cwd);
    const canonical = resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
    if (canonical === undefined) return false;
    return scopes.some((scope) =>
      scope[input.roots].some((root) => acpPathIsWithinRoot(canonical, root)),
    );
  };

  return {
    recordApproval: (input) => {
      const grants = scopeFor(input);
      if (input.kind === "command") {
        grants.execute = true;
        return;
      }
      if (input.kind === "file-read") {
        if (input.locations.length === 0) {
          grants.unscopedRead = true;
          return;
        }
        recordPathGrant(grants.readRoots, input);
        return;
      }
      if (input.kind !== "file-change") return;
      if (input.locations.length === 0) {
        grants.unscopedWrite = true;
        return;
      }
      recordPathGrant(grants.writeRoots, input);
    },
    allowsRead: ({ path, cwd, turnKey }) =>
      allowsPath({ path, cwd, turnKey, unscoped: "unscopedRead", roots: "readRoots" }),
    allowsWrite: ({ path, cwd, turnKey }) =>
      allowsPath({ path, cwd, turnKey, unscoped: "unscopedWrite", roots: "writeRoots" }),
    allowsExecute: (turnKey) => activeScopes(turnKey).some((scope) => scope.execute),
  };
}
