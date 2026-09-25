import {
  AuthOrchestrationReadScope,
  type PrismProviderSnapshot,
  type PrismRoleKits,
  type PrismSnapshotRoles,
  ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const PRISM_SNAPSHOT_PATH = "/api/prism/snapshot";

/**
 * Kits in the snapshot shape: the worker's lanes as saved, every other role's
 * single list repeated in each lane for routers that still read lanes.
 */
function snapshotRoles(kits: PrismRoleKits): PrismSnapshotRoles {
  const single = <Kit extends { readonly models: PrismRoleKits["planner"]["models"] }>(
    kit: Kit,
  ) => ({ ...kit, lanes: { easy: kit.models, medium: kit.models, hard: kit.models } });
  return {
    planner: single(kits.planner),
    dispatcher: single(kits.dispatcher),
    reviewer: single(kits.reviewer),
    worker: kits.worker,
    correction: single(kits.correction),
    recovery: single(kits.recovery),
  };
}

/**
 * The Prism router's view of this environment: every provider instance with
 * its models, option descriptors and usage windows, and the role kits
 * resolved for `projectId` (environment values when null).
 */
export function makePrismSnapshot(input: {
  readonly generatedAt: string;
  readonly projectId: ProjectId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
}): PrismProviderSnapshot {
  return {
    generatedAt: input.generatedAt,
    projectId: input.projectId,
    providers: input.providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      enabled: provider.enabled && provider.availability !== "unavailable",
      status: provider.status,
      models: provider.models,
      ...(provider.usageLimits ? { usageLimits: provider.usageLimits } : {}),
    })),
    roles: snapshotRoles(
      resolveProjectSettings(input.settings, input.projectId).settings.prismRoles,
    ),
  };
}

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

/** `GET /api/prism/snapshot[?projectId=…]`, bearer token with `orchestration:read`. */
export const prismSnapshotRouteLayer = HttpRouter.add(
  "GET",
  PRISM_SNAPSHOT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session)) return jsonError(401, "unauthorized");
    if (!session.value.scopes.includes(AuthOrchestrationReadScope)) {
      return jsonError(403, `scope ${AuthOrchestrationReadScope} required`);
    }
    const url = HttpServerRequest.toURL(request);
    const rawProjectId = Option.isSome(url) ? url.value.searchParams.get("projectId") : null;
    const projectId = rawProjectId?.trim() ? ProjectId.make(rawProjectId.trim()) : null;
    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return jsonError(500, "settings unavailable");
    const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
    const generatedAt = DateTime.formatIso(yield* DateTime.now);
    return HttpServerResponse.jsonUnsafe(
      makePrismSnapshot({ generatedAt, projectId, providers, settings: settings.value }),
    );
  }),
);
