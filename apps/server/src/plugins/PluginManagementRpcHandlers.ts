import {
  PluginManagementError,
  type PluginCatalogResult,
  type PluginCheckUpdatesResult,
  type PluginInstallBeginInput,
  type PluginInstallConfirmResult,
  type PluginInstallStaged,
  type PluginSetEnabledInput,
  type PluginSource,
  type PluginSourcesAddInput,
  type PluginSourcesAddResult,
  type PluginSourcesListResult,
  type PluginSourcesRemoveInput,
  type PluginUninstallInput,
  type PluginUpgradeBeginInput,
  type PluginSettingsGetInput,
  type PluginSettingsGetResult,
  type PluginSettingsSetInput,
  type PluginSettingsSetResult,
  type PluginUpgradeConfirmResult,
} from "@t3tools/contracts/plugin";
import {
  fingerprintSettingsSchema,
  settingsJsonSchemaRoot,
  stripUndeclaredProperties,
} from "@t3tools/shared/pluginSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PluginInstaller } from "./PluginInstaller.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import { PluginRuntimeRegistry } from "./PluginRuntimeRegistry.ts";
import { PluginSettingsStore } from "./PluginSettingsStore.ts";
import { isSameMarketplaceSource, PluginMarketplace, sourceIdForUrl } from "./PluginMarketplace.ts";

const managementError = (code: PluginManagementError["code"], message: string, data?: unknown) =>
  new PluginManagementError({
    code,
    message,
    ...(data === undefined ? {} : { data }),
  });

const lockfileError = (cause: unknown) =>
  managementError(
    "lockfile",
    cause instanceof Error ? cause.message : "Plugin lockfile update failed.",
    {
      cause,
    },
  );
const isPluginManagementError = Schema.is(PluginManagementError);
const toManagementError = (cause: unknown) =>
  isPluginManagementError(cause) ? cause : lockfileError(cause);

export class PluginManagementRpcHandlers extends Context.Service<
  PluginManagementRpcHandlers,
  {
    readonly listSources: Effect.Effect<PluginSourcesListResult, PluginManagementError>;
    readonly addSource: (
      input: PluginSourcesAddInput,
    ) => Effect.Effect<PluginSourcesAddResult, PluginManagementError>;
    readonly removeSource: (
      input: PluginSourcesRemoveInput,
    ) => Effect.Effect<void, PluginManagementError>;
    readonly catalog: (input: {
      readonly sourceId?: string;
    }) => Effect.Effect<PluginCatalogResult, PluginManagementError>;
    readonly beginInstall: (
      input: PluginInstallBeginInput,
    ) => Effect.Effect<PluginInstallStaged, PluginManagementError>;
    readonly confirmInstall: (
      stageToken: string,
    ) => Effect.Effect<PluginInstallConfirmResult, PluginManagementError>;
    readonly abortInstall: (stageToken: string) => Effect.Effect<void, PluginManagementError>;
    readonly setEnabled: (
      input: PluginSetEnabledInput,
    ) => Effect.Effect<void, PluginManagementError>;
    readonly uninstall: (input: PluginUninstallInput) => Effect.Effect<void, PluginManagementError>;
    readonly beginUpgrade: (
      input: PluginUpgradeBeginInput,
    ) => Effect.Effect<PluginInstallStaged, PluginManagementError>;
    readonly confirmUpgrade: (
      stageToken: string,
    ) => Effect.Effect<PluginUpgradeConfirmResult, PluginManagementError>;
    readonly checkUpdates: Effect.Effect<PluginCheckUpdatesResult, PluginManagementError>;
    readonly settingsGet: (
      input: PluginSettingsGetInput,
    ) => Effect.Effect<PluginSettingsGetResult, PluginManagementError>;
    readonly settingsSet: (
      input: PluginSettingsSetInput,
    ) => Effect.Effect<PluginSettingsSetResult, PluginManagementError>;
  }
>()("t3/plugins/PluginManagementRpcHandlers") {}

export const make = Effect.fn("PluginManagementRpcHandlers.make")(function* () {
  const store = yield* PluginLockfileStore;
  const registry = yield* PluginRuntimeRegistry;
  const settingsStore = yield* PluginSettingsStore;
  const marketplace = yield* PluginMarketplace;
  const installer = yield* PluginInstaller;

  const listSources = store.readLockfile.pipe(
    Effect.map((lockfile) => ({ sources: Array.from(lockfile.sources) })),
    Effect.mapError(lockfileError),
  );

  const addSource: PluginManagementRpcHandlers["Service"]["addSource"] = (input) =>
    Effect.gen(function* () {
      const normalized = yield* marketplace.normalizeSourceUrl(input.url);
      const id = sourceIdForUrl(normalized);
      const now = DateTime.formatIso(yield* DateTime.now);
      const source = yield* store
        .updateSources((sources) => {
          // Dedupe on the canonical form so a source persisted before credential
          // stripping (or otherwise differing only by strippable parts) is not
          // registered a second time under a different sourceId.
          const existing = sources.find((candidate) =>
            isSameMarketplaceSource(candidate.url, normalized),
          );
          if (existing) {
            // Rewrite a legacy credentialed (or otherwise non-canonical) URL to
            // its credential-stripped canonical form so it stops leaking via
            // listSources / error payloads. Keep the existing (opaque) sourceId
            // so installed plugins that reference it are unaffected.
            if (existing.url === normalized) return Effect.succeed(sources);
            return Effect.succeed(
              sources.map((candidate) =>
                candidate === existing ? { ...candidate, url: normalized } : candidate,
              ),
            );
          }
          return Effect.succeed([...sources, { id, url: normalized, addedAt: now }]);
        })
        .pipe(Effect.mapError(toManagementError));
      const entry = source.sources.find((candidate) =>
        isSameMarketplaceSource(candidate.url, normalized),
      );
      if (!entry) {
        return yield* managementError("invalid-source", "Failed to add plugin source.", {
          url: normalized,
        });
      }
      return { source: entry };
    });

  const removeSource: PluginManagementRpcHandlers["Service"]["removeSource"] = (input) =>
    Effect.gen(function* () {
      // Validate "source exists" and "source not used by an installed plugin"
      // INSIDE updateSources' critical section, against the lockfile read under
      // the advisory lock. Doing the check outside (via a separate readLockfile)
      // races a concurrent install that could reference this source between the
      // check and the removal, leaving a dangling sourceId.
      let rejection: PluginManagementError | null = null;
      yield* store
        .updateSources((sources, lockfile) => {
          if (!sources.some((source) => source.id === input.sourceId)) {
            rejection = managementError("source-not-found", "Plugin source was not found.", {
              sourceId: input.sourceId,
            });
            return Effect.succeed(sources);
          }
          const usedBy = Object.entries(lockfile.plugins).find(
            ([, plugin]) => plugin.sourceId === input.sourceId,
          )?.[0];
          if (usedBy) {
            rejection = managementError(
              "invalid-source",
              "Plugin source is still used by an installed plugin.",
              {
                sourceId: input.sourceId,
                pluginId: usedBy,
              },
            );
            return Effect.succeed(sources);
          }
          return Effect.succeed(sources.filter((source) => source.id !== input.sourceId));
        })
        .pipe(Effect.asVoid, Effect.mapError(toManagementError));
      if (rejection !== null) {
        return yield* rejection as PluginManagementError;
      }
    });

  const catalog: PluginManagementRpcHandlers["Service"]["catalog"] = (input) =>
    Effect.gen(function* () {
      const lockfile = yield* store.readLockfile.pipe(Effect.mapError(lockfileError));
      return yield* marketplace.catalog(
        lockfile.sources as ReadonlyArray<PluginSource>,
        input.sourceId,
      );
    });

  // The declared schema lives on the live runtime's definition, so settings are
  // only readable/writable while the plugin is active. Keying off the runtime (not
  // a client-supplied id) is also what makes cross-plugin access impossible.
  // Resolve from the live runtime first, then fall back to what the plugin DECLARED
  // at module load.
  //
  // The fallback is what keeps the repair path reachable. A plugin that reads its
  // settings during register() fails activation when the stored row is unreadable,
  // so no runtime is ever put — and resolving only from runtimes would report "no
  // settings declared", hiding the form the user needs to fix the very values that
  // broke activation.
  const declaredSettings = (pluginId: PluginSettingsGetInput["pluginId"]) =>
    Effect.gen(function* () {
      const runtime = yield* registry.get(pluginId);
      const fromRuntime = Option.flatMap(runtime, (value) =>
        value.settings === undefined ? Option.none() : Option.some(value.settings),
      );
      if (Option.isSome(fromRuntime)) return fromRuntime;
      const fromDeclaration = yield* settingsStore.declaredSchema(pluginId);
      return Option.map(fromDeclaration, (schema) => ({ schema }) as never);
    });

  const settingsGet: PluginManagementRpcHandlers["Service"]["settingsGet"] = (input) =>
    Effect.gen(function* () {
      const declared = yield* declaredSettings(input.pluginId);
      if (Option.isNone(declared)) {
        return {
          values: {},
          revision: 0,
          incompatible: false,
          declared: false,
        } satisfies PluginSettingsGetResult;
      }
      const draft = yield* settingsStore.readDraft(input.pluginId);
      // An upgrade can change the schema under stored values. Compare the shape
      // that produced them against the current one and flag a mismatch, so the
      // form can say "these need attention" and repair them. The data is NOT
      // discarded — the user may need to read it to reconstruct the new values.
      const currentFingerprint = fingerprintSettingsSchema(declared.value.schema);
      const staleShape =
        draft.schemaFingerprint !== null && draft.schemaFingerprint !== currentFingerprint;

      // Also DECODE, not just compare fingerprints. A row can carry the current
      // fingerprint and still be invalid — e.g. `{ baseUrl: 42 }` written before a
      // check tightened, or edited out of band. Reporting incompatible: false for it
      // would tell the form everything is fine while the plugin's own read fails.
      const decodes =
        draft.revision === 0
          ? true
          : yield* Schema.decodeUnknownEffect(declared.value.schema)(draft.values).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );

      return {
        values: draft.values,
        revision: draft.revision,
        incompatible: draft.incompatible || staleShape || !decodes,
        declared: true,
      } satisfies PluginSettingsGetResult;
    });

  const settingsSet: PluginManagementRpcHandlers["Service"]["settingsSet"] = (input) =>
    Effect.gen(function* () {
      const declared = yield* declaredSettings(input.pluginId);
      if (Option.isNone(declared)) {
        return yield* Effect.fail(
          managementError(
            "settings-not-declared",
            "This plugin does not declare settings, or is not currently enabled.",
          ),
        );
      }

      // Decode server-side even though the form already validated: the client is
      // not trusted, and a bad write would land config the plugin cannot read.
      const decoded = yield* Schema.decodeUnknownEffect(declared.value.schema)(input.values).pipe(
        Effect.mapError(() =>
          // Deliberately does not embed the decode error: its rendering contains the
          // submitted values, which would put plugin configuration into logs.
          managementError("settings-invalid", "These settings do not match the plugin's schema."),
        ),
      );

      // Persist the ENCODED shape, canonicalised by re-encoding what we decoded —
      // never the raw client payload (which could carry unknown keys) and never the
      // decoded values (whose re-encode may differ, breaking the next read).
      const encoded = yield* Schema.encodeEffect(declared.value.schema)(decoded).pipe(
        Effect.mapError(() =>
          managementError("settings-invalid", "These settings could not be stored."),
        ),
      );

      // Strip anything the schema does not declare, at EVERY level, on the HOST side.
      //
      // decode->re-encode is NOT a guarantee the host owns: `parseOptions` is a schema
      // ANNOTATION, so a plugin can declare `onExcessProperty: "preserve"` and carry
      // arbitrary client keys through both operations. A root-level filter was not
      // enough either — a hidden field can hold a nested Struct with its own preserve
      // annotation, which smuggles keys past it. Walking the derived JSON Schema makes
      // this structural rather than trusting anything the plugin declared.
      const canonical = stripUndeclaredProperties(
        encoded as Readonly<Record<string, unknown>>,
        settingsJsonSchemaRoot(declared.value.schema as never),
      ) as Readonly<Record<string, unknown>>;

      const revision = yield* settingsStore
        .write({
          pluginId: input.pluginId,
          values: canonical,
          schemaFingerprint: fingerprintSettingsSchema(declared.value.schema),
          expectedRevision: input.expectedRevision,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "PluginSettingsConflictError"
              ? managementError(
                  "settings-conflict",
                  "These settings changed elsewhere. Reload and reapply your edit.",
                )
              : managementError("lockfile", "Could not store plugin settings."),
          ),
        );
      return { revision } satisfies PluginSettingsSetResult;
    });

  return PluginManagementRpcHandlers.of({
    listSources,
    addSource,
    removeSource,
    catalog,
    settingsGet,
    settingsSet,
    beginInstall: installer.beginInstall,
    confirmInstall: installer.confirmInstall,
    abortInstall: installer.abortInstall,
    setEnabled: installer.setEnabled,
    uninstall: installer.uninstall,
    beginUpgrade: installer.beginUpgrade,
    confirmUpgrade: installer.confirmUpgrade,
    checkUpdates: installer.checkUpdates,
  });
});

export const layer = Layer.effect(PluginManagementRpcHandlers, make());
