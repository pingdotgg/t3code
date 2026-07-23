import type { NamespaceNode } from "../Namespace.ts";
import type { RemovalPolicy } from "../RemovalPolicy.ts";
import type { ResourceBinding } from "../Resource.ts";

export type ResourceState =
  | CreatingResourceState
  | CreatedResourceState
  | UpdatingReourceState
  | UpdatedResourceState
  | DeletingResourceState
  | ReplacingResourceState
  | ReplacedResourceState;

export type Props = Record<string, any>;
export type Attr = Record<string, any>;

export type ResourceStatus = ResourceState["status"];
export type ReplacementResourceState =
  | ReplacingResourceState
  | ReplacedResourceState;
export type ReplacementOldResourceState =
  | CreatingResourceState
  | CreatedResourceState
  | UpdatingReourceState
  | UpdatedResourceState
  | DeletingResourceState
  | ReplacementResourceState;

interface BaseResourceState {
  /**
   * Discriminator vs {@link ActionState}. Optional for back-compat: legacy
   * persisted rows have no `kind` field and are implicitly resources.
   */
  readonly kind?: "resource";
  /** Type of the Resource (e.g. AWS.Lambda.Function) */
  resourceType: string;
  /** Namespace of the Resource */
  namespace: NamespaceNode | undefined;
  /** Fully Qualified Name (namespace path + logical ID) */
  fqn: string;
  /** Logical ID of the Resource (stable across creates, updates, deletes and replaces) */
  logicalId: string;
  /** A unique randomly generated token used to seed ID generation (only changes when replaced) */
  instanceId: string;
  /** The version of the provider that was used to create/update the resource. */
  providerVersion: number;
  /** Current status of the logical Resource */
  status: ResourceStatus;
  /** List of FQNs of resources that depend on this resource */
  downstream: string[];
  /** List of Bindings attached to this Resource */
  bindings: ResourceBinding[];
  /** Desired state (input props) of this Resource */
  props?: Props;
  /** The output attributes of this Resource (if it has been created) */
  attr?: Attr;
  /** The removal policy of the resource */
  removalPolicy?: RemovalPolicy["Service"];
}

export interface CreatingResourceState extends BaseResourceState {
  status: "creating";
  /** The new resource properties that are being (or have been) applied. */
  props: Props;
}

export interface CreatedResourceState extends BaseResourceState {
  status: "created";
  /** The new resource properties that have been applied. */
  props: Props;
  /** The output attributes of the created resource */
  attr: Attr;
}

export interface UpdatingReourceState extends BaseResourceState {
  status: "updating";
  /** The new resource properties that are being (or have been) applied. */
  props: Props;
  old: {
    /** The old resource properties that have been successfully applied. */
    props: Props;
    /** List of Bindings attached to this Resource */
    bindings: any[];
    /** The old output properties that have been successfully applied. */
    attr: Attr;
    // TODO(sam): do I need to track the old downstream edges?
    // downstream: string[];
  };
}

export interface UpdatedResourceState extends BaseResourceState {
  status: "updated";
  /** The new resource properties that are being (or have been) applied. */
  props: Props;
  /** The output attributes of the created resource */
  attr: Attr;
}

export interface DeletingResourceState extends BaseResourceState {
  status: "deleting";
  /** Attributes of the resource being deleted */
  attr: Attr | undefined;
}

export interface ReplacingResourceState extends BaseResourceState {
  status: "replacing";
  /** Desired properties of the new resource (the replacement) */
  props: Props;
  /** Reference to the state of the old resource (the one being replaced) */
  old: ReplacementOldResourceState;
  /** Whether the resource should be deleted before or after replacements */
  deleteFirst: boolean;
}

export interface ReplacedResourceState extends BaseResourceState {
  status: "replaced";
  /** Desired properties of the new resource (the replacement) */
  props: Props;
  /** Output attributes of the new resource (the replacement) */
  attr: Attr;
  /** Reference to the state of the old resource (the one being replaced) */
  old: ReplacementOldResourceState;
  /** Whether the resource should be deleted before or after replacements */
  deleteFirst: boolean;
  // .. will (finally) transition to `CreatedResourceState` after finalizing
}
