import * as Layer from "effect/Layer";

import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentProjectFileCoordinator from "./AgentProjectFileCoordinator.ts";
import * as AgentProfileStore from "./AgentProfileStore.ts";
import * as AgentRuleStore from "./AgentRuleStore.ts";

const catalogLayer = AgentCatalog.layer.pipe(Layer.provide(T3ProjectFileLoader.layer));
const projectFileCoordinatorLayer = AgentProjectFileCoordinator.layer;

/** Shared profile/rule catalog and CAS stores for RPC and runtime consumers. */
export const layer = Layer.mergeAll(
  catalogLayer,
  AgentProfileStore.layer.pipe(Layer.provide(catalogLayer)),
  AgentRuleStore.layer.pipe(Layer.provide(catalogLayer)),
).pipe(Layer.provide(projectFileCoordinatorLayer));
