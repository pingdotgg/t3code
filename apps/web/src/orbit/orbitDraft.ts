import type {
  OrbitExistingInstance,
  OrbitGatewayBranchSelection,
  OrbitGatewayProject,
  OrbitInstanceKind,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  EnvironmentId,
  ProjectId,
  type ModelSelection,
  type OrbitInstanceDescriptor,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Conn: where an Orbit draft starts (FORK.md, "Orbit"). An Orbit Project is no T3 project, so the
 * draft is anchored on a real environment for its model list. Not the worktree env mode "orbit".
 */
export const OrbitDraftExistingInstance = Schema.Struct({
  instanceId: Schema.Number,
  environmentId: Schema.String,
});
export type OrbitDraftExistingInstance = typeof OrbitDraftExistingInstance.Type;

/** The branch a new Instance works on: cut a new one `from` a branch, or work on `name`. */
export const OrbitDraftBranch = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("new"), from: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("existing"), name: Schema.String }),
]);

export const OrbitDraftTarget = Schema.Struct({
  projectId: Schema.Number,
  projectSlug: Schema.String,
  projectName: Schema.String,
  nodeName: Schema.String,
  instanceKind: Schema.Literals(["new", "existing"]),
  /** The name the user typed for a new Instance, or the existing Instance's name. */
  instanceName: Schema.String,
  /** Set for an existing Instance this device has not paired yet. */
  existing: Schema.NullOr(OrbitDraftExistingInstance),
  /** Such as `.nckrtl.test`, when Orbit or a seen clone gave it. */
  domainSuffix: Schema.NullOr(Schema.String),
  /** New Instance only. Missing or null: "From <default>", and the create sends no branch. */
  branch: Schema.optionalKey(Schema.NullOr(OrbitDraftBranch)),
  /** The Project's default branch once the branch list was read. */
  defaultBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type OrbitDraftTarget = typeof OrbitDraftTarget.Type;

const decodeOrbitDraftTarget = Schema.decodeUnknownOption(OrbitDraftTarget);

function withoutBranch(value: object): object {
  const { branch: _dropped, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** A saved target, or null when the row is missing, old or broken. */
export function readOrbitDraftTarget(value: unknown): OrbitDraftTarget | null {
  if (value === undefined || value === null) return null;
  // A branch choice this build cannot read must not lose the rest of the target.
  const decoded =
    Option.getOrNull(decodeOrbitDraftTarget(value)) ??
    (typeof value === "object" && "branch" in value
      ? Option.getOrNull(decodeOrbitDraftTarget(withoutBranch(value)))
      : null);
  if (decoded === null) return null;
  if (decoded.instanceKind === "existing" && decoded.existing === null) return null;
  if (decoded.instanceName.trim() === "") return null;
  const branch = decoded.branch ?? null;
  // A broken or misplaced choice reads as none: the create then behaves as before.
  if (
    branch !== null &&
    (decoded.instanceKind !== "new" || (branch.mode === "new" ? branch.from : branch.name) === "")
  ) {
    return withoutBranch(decoded) as OrbitDraftTarget;
  }
  return decoded;
}

export function orbitDraftTargetsEqual(
  left: OrbitDraftTarget | null | undefined,
  right: OrbitDraftTarget | null | undefined,
): boolean {
  if (!left || !right) return (left ?? null) === (right ?? null);
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The draft's project id. It names no T3 project, so the composer finds no `activeProject` and
 * no project tools (git, scripts, worktrees) act on the anchor environment.
 */
export function orbitDraftProjectId(orbitProjectId: number): ProjectId {
  return ProjectId.make(`orbit-project:${orbitProjectId}`);
}

/** One Orbit draft per Orbit Project, like one draft per T3 project. */
export function orbitDraftLogicalProjectKey(orbitProjectId: number): string {
  return `orbit-project:${orbitProjectId}`;
}

/** No saved environment lends a model list: the start sends no model and the Instance's default runs. */
export const ORBIT_DRAFT_NO_ENVIRONMENT_ID = EnvironmentId.make("orbit-draft:no-environment");

export function isOrbitDraftWithoutEnvironment(environmentId: string): boolean {
  return environmentId === ORBIT_DRAFT_NO_ENVIRONMENT_ID;
}

/**
 * The environment that lends the draft its model list; the start itself runs through the Gateway.
 * A Project with no Instances must open with no primary environment (local environment off), so
 * after a paired clone and the primary come this app's host server, then any enabled environment.
 */
export function chooseOrbitDraftAnchor(input: {
  readonly orbitProjectId: number;
  readonly orbitInstances: Readonly<Record<string, OrbitInstanceDescriptor>>;
  readonly savedEnvironments: ReadonlyMap<string, { readonly enabled: boolean }>;
  readonly primaryEnvironmentId: string | null;
  readonly hostEnvironmentId: string | null;
}): EnvironmentId {
  const saved = [...input.savedEnvironments.keys()].toSorted();
  const clone = saved.find(
    (environmentId) => input.orbitInstances[environmentId]?.projectId === input.orbitProjectId,
  );
  const enabled = (environmentId: string | null | undefined) =>
    environmentId != null && input.savedEnvironments.get(environmentId)?.enabled === true;
  // A switched-off environment lends no model list and no session, so it never anchors.
  const anchor =
    clone ??
    input.primaryEnvironmentId ??
    (enabled(input.hostEnvironmentId) ? input.hostEnvironmentId : null) ??
    saved.find(enabled);
  return anchor ? EnvironmentId.make(anchor) : ORBIT_DRAFT_NO_ENVIRONMENT_ID;
}

export interface OrbitDraftContextRow {
  /** Plain text: the Node menu waits for Orbit. */
  readonly nodeLabel: string;
  /** `<instance slug> · <project slug>`. */
  readonly instanceLabel: string;
  readonly instanceTitle: string;
}

export function orbitDraftContextRow(target: OrbitDraftTarget): OrbitDraftContextRow {
  const instanceLabel = `${target.instanceName} · ${target.projectSlug}`;
  return {
    nodeLabel: target.nodeName,
    instanceLabel,
    instanceTitle:
      target.instanceKind === "new"
        ? `New instance ${target.instanceName}${target.domainSuffix ?? ""} in ${target.projectName}. Click to change.`
        : `Instance ${target.instanceName} of ${target.projectName}. Click to change.`,
  };
}

export const ORBIT_NEW_INSTANCE_ATTACHMENTS_NOTICE =
  "Attachments are not available for a new Instance yet.";
export const ORBIT_UNPAIRED_INSTANCE_ATTACHMENTS_NOTICE =
  "Attachments are not available until this Instance is connected.";

/**
 * Why the composer takes no attachments, or null. The start machine sends the first message as
 * text only (v1, decided), so the attach control says so instead of looking broken.
 */
export function orbitDraftAttachmentsBlockedReason(
  target: OrbitDraftTarget | null | undefined,
): string | null {
  if (!target) return null;
  return target.instanceKind === "new"
    ? ORBIT_NEW_INSTANCE_ATTACHMENTS_NOTICE
    : ORBIT_UNPAIRED_INSTANCE_ATTACHMENTS_NOTICE;
}

/** The Gateway project the start record needs, from the target alone. */
export function orbitDraftGatewayProject(
  target: OrbitDraftTarget,
): Pick<OrbitGatewayProject, "id" | "slug" | "nodeName"> {
  return { id: target.projectId, slug: target.projectSlug, nodeName: target.nodeName };
}

export interface OrbitDraftStartInput {
  readonly project: Pick<OrbitGatewayProject, "id" | "slug" | "nodeName">;
  readonly message: string;
  readonly instanceKind: OrbitInstanceKind;
  readonly instanceName: string;
  readonly existing: OrbitExistingInstance | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly projectName?: string;
  readonly instanceDomainSuffix?: string | null;
  readonly branch: OrbitGatewayBranchSelection | null;
  readonly defaultBranch: string | null;
}

/**
 * What the composer hands to the start machine for an Orbit draft. Only a new Instance carries a
 * branch choice.
 */
export function buildOrbitDraftStart(input: {
  readonly target: OrbitDraftTarget;
  readonly message: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): OrbitDraftStartInput {
  const { target } = input;
  return {
    project: orbitDraftGatewayProject(target),
    message: input.message,
    instanceKind: target.instanceKind,
    instanceName: target.instanceName,
    existing:
      target.instanceKind === "existing" && target.existing !== null
        ? {
            instanceId: target.existing.instanceId,
            environmentId: target.existing.environmentId,
            name: target.instanceName,
            nodeName: target.nodeName,
          }
        : null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    projectName: target.projectName,
    instanceDomainSuffix: target.domainSuffix,
    branch: target.instanceKind === "new" ? (target.branch ?? null) : null,
    defaultBranch: target.defaultBranch ?? null,
  };
}
