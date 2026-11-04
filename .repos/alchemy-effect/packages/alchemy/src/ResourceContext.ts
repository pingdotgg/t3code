import * as Context from "effect/Context";

/**
 * Identity of the resource whose provider lifecycle operation (`diff`, `read`,
 * `precreate`, `reconcile`, `delete`, …) is running. The engine provides it for
 * the duration of each call, so helpers several calls below a reconciler
 * (e.g. `Bundle.build`) can key per-resource state without the provider
 * threading its identity through. Absent outside a lifecycle operation.
 */
export class ResourceContext extends Context.Service<
  ResourceContext,
  {
    /** Logical ID of the resource within its namespace, e.g. `Api`. */
    readonly logicalId: string;
    /**
     * Fully-qualified name (namespace path + logical ID, see `./FQN.ts`),
     * unique within the stack, e.g. `Backend/Api`.
     */
    readonly fqn: string;
    /** Instance ID of the physical resource; changes on replacement. */
    readonly instanceId: string;
    /** Resource type, e.g. `Cloudflare.Worker`. */
    readonly type: string;
  }
>()("ResourceContext") {}
