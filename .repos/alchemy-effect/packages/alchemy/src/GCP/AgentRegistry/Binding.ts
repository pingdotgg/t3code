import * as registry from "@distilled.cloud/gcp/agentregistry_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  MAX_DISPLAY_NAME_LENGTH,
  encodeOwnership,
  hasOwnershipMarker,
  listBindings,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  resourceName,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  waitForDeleteOperation,
  waitForOperation,
  waitForVisible,
  waitUntilGone,
} from "./internal.ts";

export type AuthProviderBinding = {
  /**
   * Auth provider resource name
   * `projects/{project}/locations/{location}/connectors/{auth_provider}`
   * or `.../authProviders/{auth_provider}`.
   */
  authProvider: string;
  /**
   * OAuth2 scopes requested from the auth provider.
   */
  scopes?: string[];
  /**
   * Continue URI used to reauthenticate the user and finalize the
   * managed OAuth flow.
   */
  continueUri?: string;
};

export type BindingProps = {
  /**
   * Binding id (the `{binding}` segment of
   * `projects/{project}/locations/{location}/bindings/{binding}`). If
   * omitted, a unique RFC1035 name is generated. Must be 4-63 characters
   * matching `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`. Immutable — changing
   * it replaces the binding.
   */
  bindingId?: string;
  /**
   * Location of the binding (`us-central1`, `global`, …). Multi-region
   * `us` and `eu` are not supported. Immutable — changing it replaces
   * the binding.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * URN of the source agent (`urn:agent:{publisher}:{namespace}:{name}`).
   * Immutable — changing it replaces the binding.
   */
  sourceIdentifier: string;
  /**
   * URN of the target agent, MCP server, or endpoint
   * (`urn:agent:…`, `urn:mcp:…`, or `urn:endpoint:…`). Immutable —
   * changing it replaces the binding.
   */
  targetIdentifier: string;
  /**
   * Human-readable name. Max 63 characters. Defaults to the binding id.
   */
  displayName?: string;
  /**
   * Human-readable description (max 2048 characters). Bindings have no
   * labels field, so Alchemy stamps ownership into a `[alchemy …]`
   * prefix and strips it from attributes.
   */
  description?: string;
  /**
   * Optional auth-provider binding for delegated permissions.
   */
  authProviderBinding?: AuthProviderBinding;
};

export type Binding = Resource<
  "GCP.AgentRegistry.Binding",
  BindingProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/bindings/{binding}`. */
    name: string;
    /** Binding id (last path segment). */
    bindingId: string;
    /** Project id. */
    project: string;
    /** Location id of the resource. */
    location: string;
    /** Source agent URN. */
    sourceIdentifier: string | undefined;
    /** Target agent, MCP server, or endpoint URN. */
    targetIdentifier: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Auth-provider binding, if set. */
    authProviderBinding: AuthProviderBinding | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Agent Registry binding connecting a source agent to a target
 * agent, MCP server, or endpoint.
 *
 * Create, update, and delete are long-running operations. `bindingId`,
 * `location`, `sourceIdentifier`, and `targetIdentifier` replace the
 * resource. Display name, description, and auth-provider settings
 * update in place. Bindings have no labels API, so Alchemy stamps
 * ownership into `description` so `list` / nuke can find them.
 *
 * ### Creating a Binding
 * **Example:** Generated name
 * ```typescript
 * const binding = yield* GCP.AgentRegistry.Binding("Orchestrator", {
 *   sourceIdentifier:
 *     "urn:agent:projects-123:projects:123:locations:us-central1:agentregistry:source",
 *   targetIdentifier:
 *     "urn:mcp:projects-123:projects:123:locations:us-central1:agentregistry:tools",
 * });
 * ```
 *
 * **Example:** Named binding with a description
 * ```typescript
 * const binding = yield* GCP.AgentRegistry.Binding("Orchestrator", {
 *   bindingId: "orchestrator-tools",
 *   location: "us-central1",
 *   displayName: "orchestrator tools",
 *   description: "routes the orchestrator to the tools MCP server",
 *   sourceIdentifier: source.agentId,
 *   targetIdentifier: tools.mcpServerId,
 * });
 * ```
 *
 * ### Updating a Binding
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Display name and description
 * ```typescript
 * const binding = yield* GCP.AgentRegistry.Binding("Orchestrator", {
 *   sourceIdentifier: source.agentId,
 *   targetIdentifier: tools.mcpServerId,
 *   displayName: "orchestrator tools v2",
 *   description: "updated routing",
 * });
 * ```
 *
 * @resource
 * @category AgentRegistry
 */
export const Binding = Resource<Binding>("GCP.AgentRegistry.Binding");

export class BindingNotResolved extends Data.TaggedError(
  "GCP.AgentRegistry.BindingNotResolved",
)<{
  name: string;
}> {}

const COLLECTION = "bindings";

const toAuth = (
  binding: registry.AuthProviderBinding | undefined,
): AuthProviderBinding | undefined => {
  if (binding === undefined) return undefined;
  const authProvider = binding.authProvider;
  if (authProvider === undefined || authProvider.length === 0) {
    return undefined;
  }
  return {
    authProvider,
    scopes: binding.scopes,
    continueUri: binding.continueUri,
  };
};

const desiredAuth = (
  binding: AuthProviderBinding | undefined,
): registry.AuthProviderBinding | undefined => {
  if (binding === undefined) return undefined;
  return {
    authProvider: binding.authProvider,
    scopes: binding.scopes,
    continueUri: binding.continueUri,
  };
};

const authKey = (
  binding: AuthProviderBinding | registry.AuthProviderBinding | undefined,
) =>
  binding === undefined
    ? undefined
    : {
        authProvider: binding.authProvider,
        continueUri: binding.continueUri,
        scopes: [...(binding.scopes ?? [])].slice().sort(),
      };

const toAttrs = (item: registry.Binding, project: string, location: string) => {
  const name = item.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  const owned = parseOwnership(item.description);
  return {
    name,
    bindingId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    sourceIdentifier: item.source?.identifier,
    targetIdentifier: item.target?.identifier,
    displayName: item.displayName,
    description: owned.description,
    authProviderBinding: toAuth(item.authProviderBinding),
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : registry
        .getProjectsLocationsBindings({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const displayNameOf = (news: BindingProps, bindingId: string) =>
  (news.displayName ?? bindingId).slice(0, MAX_DISPLAY_NAME_LENGTH);

export const BindingProvider = () =>
  Provider.succeed(Binding, {
    stables: ["name", "bindingId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSource = olds?.sourceIdentifier ?? output?.sourceIdentifier;
      const previousTarget = olds?.targetIdentifier ?? output?.targetIdentifier;
      return replaceOnIdentity({
        previousId: olds?.bindingId ?? output?.bindingId,
        nextId: news.bindingId ?? olds?.bindingId ?? output?.bindingId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousSource !== undefined &&
            previousSource !== news.sourceIdentifier) ||
          (previousTarget !== undefined &&
            previousTarget !== news.targetIdentifier),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const bindingId = yield* toPhysicalId(
        id,
        olds?.bindingId,
        output?.bindingId,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, bindingId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listBindings(env.project, env.region);
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const bindingId = yield* toPhysicalId(
        id,
        news.bindingId,
        output?.bindingId,
      );
      const name = resourceName(env.project, location, COLLECTION, bindingId);
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = displayNameOf(news, bindingId);
      const source = { identifier: news.sourceIdentifier };
      const target = { identifier: news.targetIdentifier };
      const authProviderBinding = desiredAuth(news.authProviderBinding);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          registry.createProjectsLocationsBindings({
            parent,
            bindingId,
            body: {
              source,
              target,
              displayName,
              description,
              authProviderBinding,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (code 6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchIf(
              (error) =>
                error._tag === "GCP.OperationFailed" && error.code === 6,
              () => Effect.void,
            ),
          );
        }
        current = yield* waitForVisible(getByName(name));
      }

      if (current === undefined) {
        return yield* new BindingNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const sourceChanged = !sameText(
        current.source?.identifier,
        news.sourceIdentifier,
      );
      const targetChanged = !sameText(
        current.target?.identifier,
        news.targetIdentifier,
      );
      const authChanged = !sameJson(
        authKey(current.authProviderBinding),
        authKey(news.authProviderBinding),
      );

      const mask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        descriptionChanged ? "description" : undefined,
        sourceChanged ? "source" : undefined,
        targetChanged ? "target" : undefined,
        authChanged ? "auth_provider_binding" : undefined,
      );

      if (mask.length > 0) {
        const operation = yield* retryTransient(
          registry.patchProjectsLocationsBindings({
            name: currentName,
            updateMask: mask,
            body: {
              name: currentName,
              displayName,
              description,
              source,
              target,
              authProviderBinding,
            },
          }),
        );
        yield* waitForOperation(operation);
        current = (yield* waitForVisible(getByName(currentName))) ?? current;
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const deleted = yield* retryTransient(
        registry.deleteProjectsLocationsBindings({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (deleted !== undefined) {
        yield* waitForDeleteOperation(deleted);
      }
      yield* waitUntilGone(getByName(output.name));
    }),
  });
