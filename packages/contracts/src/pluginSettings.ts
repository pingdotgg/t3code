/**
 * Declarative plugin settings: the shared schema TYPE.
 *
 * Policy — the renderable field vocabulary and the compatibility fingerprint — is
 * runtime logic and lives in `@t3tools/shared/pluginSettings`. AGENTS.md requires
 * this package to stay schema-only.
 *
 * @module pluginSettings
 */
import type * as Schema from "effect/Schema";

export type SettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;
