import {
  type ExecutionEnvironmentCapabilities,
  type PluginInstallationId,
  type PluginSettingChange,
  type PluginSettingField,
  type PluginSettingValue,
  type PluginSettingsValues,
  pluginSettingValueProblem,
  resolvePluginSettingValue,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { requestIfSupported, subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** One installation's saved values, or `unsupported` for a server that stores no plugin settings. */
export type PluginSettingsView =
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "available"; readonly values: PluginSettingsValues };

export const supportsPluginSettings = (
  capabilities: Pick<ExecutionEnvironmentCapabilities, "pluginSettings"> | null | undefined,
) => capabilities?.pluginSettings === true;

const UNSUPPORTED: PluginSettingsView = { _tag: "unsupported" };

/**
 * Follows the environment's sessions and checks each server's capability
 * before subscribing, so a server without plugin settings never receives the call.
 */
export const pluginSettingsStream = (installationId: PluginInstallationId) =>
  Stream.unwrap(
    EnvironmentSupervisor.EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (session) =>
                Stream.unwrap(
                  session.initialConfig.pipe(
                    Effect.map((config) =>
                      supportsPluginSettings(config.environment.capabilities)
                        ? subscribe(WS_METHODS.pluginsSettingsSubscribe, { installationId }).pipe(
                            Stream.map((values): PluginSettingsView => ({
                              _tag: "available",
                              values,
                            })),
                          )
                        : Stream.succeed(UNSUPPORTED),
                    ),
                    // A session that never delivered its config has nothing to show yet.
                    Effect.orElseSucceed(() => Stream.empty),
                  ),
                ),
            }),
          ),
        ),
      ),
    ),
  );

export function createPluginSettingsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    /** An installation's saved values; secrets appear only as keys that have one. */
    values: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:settings",
      subscribe: (input: { readonly installationId: PluginInstallationId }) =>
        pluginSettingsStream(input.installationId),
    }),
    /** Saves or clears values; checks the capability on the session it would use. */
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:settings:update",
      tag: WS_METHODS.pluginsSettingsUpdate,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
      execute: (input) =>
        requestIfSupported(WS_METHODS.pluginsSettingsUpdate, input, supportsPluginSettings),
    }),
  };
}

/** What a form shows for one field before the user edits it. */
export interface PluginSettingRow {
  readonly field: PluginSettingField;
  /** The value the plugin reads: saved if it still fits, else the default. Never a secret. */
  readonly value: PluginSettingValue | undefined;
  /** A value is saved; for a secret, one is stored on the server. */
  readonly saved: boolean;
  /** `value` is the declared default: nothing is saved, or the saved value no longer fits. Never for a secret. */
  readonly isDefault: boolean;
}

export const pluginSettingRows = (
  fields: ReadonlyArray<PluginSettingField>,
  values: PluginSettingsValues,
): ReadonlyArray<PluginSettingRow> =>
  fields.map((field) => {
    if (field.type === "secret")
      return {
        field,
        value: undefined,
        saved: values.secrets.includes(field.key),
        isDefault: false,
      };
    const saved = values.values.find((entry) => entry.key === field.key)?.value;
    const value = resolvePluginSettingValue(field, saved);
    return {
      field,
      value,
      saved: saved !== undefined,
      isDefault: saved === undefined || value !== saved,
    };
  });

/** A form's in-progress input for one field: text for text-like fields, a boolean for switches. */
export type PluginSettingDraft = string | boolean;

/**
 * Turns a draft into the change to save, or says why it cannot be saved. An
 * empty secret draft means "keep the saved secret" and yields no change.
 */
export const pluginSettingDraftChange = (
  field: PluginSettingField,
  draft: PluginSettingDraft,
):
  | { readonly _tag: "change"; readonly change: PluginSettingChange }
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "invalid"; readonly message: string } => {
  let value: PluginSettingValue = draft;
  if (field.type === "secret" && draft === "") return { _tag: "unchanged" };
  if (field.type === "number") {
    const text = String(draft).trim();
    value = text === "" ? Number.NaN : Number(text);
  }
  const problem = pluginSettingValueProblem(field, value);
  return problem === undefined
    ? { _tag: "change", change: { key: field.key, value } }
    : { _tag: "invalid", message: problem };
};

/** What a field shows before it is edited: its value as text, or a switch's state. */
const pluginSettingDraftOf = (row: PluginSettingRow): PluginSettingDraft =>
  row.field.type === "boolean"
    ? row.value === true
    : row.value === undefined
      ? ""
      : String(row.value);

/**
 * A form's unsaved edits by setting key. A Map, so a declared key named like an
 * object property ("constructor", "toString") holds only what the user typed.
 */
export type PluginSettingDrafts = ReadonlyMap<string, PluginSettingDraft>;

/**
 * Each row with what it shows and the change its draft makes (or why it cannot
 * be saved; undefined when it matches what is saved), and the form's changes.
 */
export const pluginSettingForm = (
  rows: ReadonlyArray<PluginSettingRow>,
  drafts: PluginSettingDrafts,
) => {
  const entries = rows.map((row) => {
    const shown = pluginSettingDraftOf(row);
    const draft = drafts.get(row.field.key) ?? shown;
    const outcome = draft === shown ? undefined : pluginSettingDraftChange(row.field, draft);
    return { row, draft, outcome: outcome?._tag === "unchanged" ? undefined : outcome };
  });
  return {
    entries,
    changes: entries.flatMap(({ outcome }) => (outcome?._tag === "change" ? [outcome.change] : [])),
    invalid: entries.some(({ outcome }) => outcome?._tag === "invalid"),
  };
};

/** The drafts once `saved` succeeded: the edits it sent are gone, others stay. */
export const pluginSettingDraftsAfterSave = (
  drafts: PluginSettingDrafts,
  saved: ReadonlyArray<PluginSettingChange>,
): PluginSettingDrafts => {
  const next = new Map(drafts);
  for (const change of saved) next.delete(change.key);
  return next;
};
