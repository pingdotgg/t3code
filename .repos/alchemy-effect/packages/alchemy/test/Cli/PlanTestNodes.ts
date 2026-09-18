import type {
  Apply,
  Create,
  Delete,
  NoopUpdate,
  Plan,
  Replace,
  Update,
} from "@/Plan.ts";
import type { ProviderService } from "@/Provider.ts";
import type { ResourceLike } from "@/Resource.ts";
import type { CreatedResourceState } from "@/State/index.ts";
import * as Effect from "effect/Effect";

const provider: ProviderService<ResourceLike> = {
  list: () => Effect.succeed([]),
  reconcile: () => Effect.succeed({}),
  delete: () => Effect.void,
};

const resource = (id: string, props: object): ResourceLike => ({
  Namespace: undefined,
  FQN: id,
  Type: "Test.Resource",
  LogicalId: id,
  Props: props,
  RemovalPolicy: "destroy",
  Adopt: undefined,
  Mode: undefined,
  RequiresImplementation: undefined,
  FormerFqns: undefined,
  Attributes: {},
  Binding: undefined,
  Providers: undefined,
});

const state = (id: string, props: object): CreatedResourceState => ({
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn: id,
  logicalId: id,
  instanceId: `test-${id}`,
  providerVersion: 0,
  status: "created",
  downstream: [],
  bindings: [],
  props,
  attr: {},
  removalPolicy: "destroy",
});

const baseNode = (id: string, props: object) => ({
  resource: resource(id, props),
  provider,
  mode: undefined,
  downstream: [],
  bindings: [],
});

export const updateNode = (
  olds: object,
  news: object,
  id = "Worker",
): Update => ({
  ...baseNode(id, news),
  action: "update",
  props: news,
  state: state(id, olds),
});

export const createNode = (props: object, id = "Worker"): Create => ({
  ...baseNode(id, props),
  action: "create",
  props,
  state: undefined,
});

export const noopNode = (props: object, id = "Worker"): NoopUpdate => ({
  ...baseNode(id, props),
  action: "noop",
  state: state(id, props),
});

export const replaceNode = (
  olds: object,
  news: object,
  id = "Worker",
): Replace => ({
  ...baseNode(id, news),
  action: "replace",
  props: news,
  state: state(id, olds),
  deleteFirst: false,
});

export const deleteNode = (props: object, id = "Worker"): Delete => ({
  ...baseNode(id, props),
  action: "delete",
  state: state(id, props),
});

export const planWith = (
  resources: Apply[] = [],
  deletions: Delete[] = [],
): Plan<undefined> => ({
  resources: Object.fromEntries(
    resources.map((node) => [node.resource.FQN, node]),
  ),
  deletions: Object.fromEntries(
    deletions.map((node) => [node.resource.FQN, node]),
  ),
  actions: {},
  actionDeletions: {},
  output: undefined,
  cycleMembers: new Set<string>(),
});
