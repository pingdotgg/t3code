import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Interaction from "../Interaction.ts";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureField,
  type ConfigureMethod,
  type EnvironmentVariable,
} from "./AuthProvider.ts";
import { displayRedacted } from "./Credentials.ts";
import { mapPromptCancellation } from "./Env.ts";

/**
 * Collected field values: one string per non-omitted field, keyed by
 * {@link ConfigureField.name}.
 */
export type StoredValue = string | Redacted.Redacted<string>;
export type StoredValues = Record<string, StoredValue | undefined>;

/** Reveal a collected value only at a validation or I/O boundary. */
export const storedValueText = (value: StoredValue | undefined) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/** Preserve or introduce redaction for a collected secret. */
export const storedSecret = (value: StoredValue | undefined) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? value
      : Redacted.make(value);

/**
 * Everything needed to generate a complete single-method ("stored")
 * {@link AuthProviderImpl} for a provider whose credential is a token (or a
 * small set of fields) the user pastes once: prompts, flag-driven
 * configuration, schema-validated inline values, login/logout, and
 * structured details.
 *
 * Providers with several auth methods (browser OAuth, SSO) don't fit this
 * factory — they hand-roll the impl and may still reuse
 * {@link collectFieldValues} for their token-shaped method.
 */
export interface StoredAuthProviderConfig<Resolved> {
  /** Registry name, e.g. `"Neon"`. */
  readonly provider: string;
  /** The fields collected interactively or via `--set`. */
  readonly fields: ReadonlyArray<ConfigureField>;
  /**
   * Derive additional stored values after input collection — e.g. resolve
   * an account id with an API call using the entered token. Runs for both
   * the interactive and flag-driven paths, before persistence.
   */
  readonly complete?: (
    values: StoredValues,
  ) => Effect.Effect<StoredValues, AuthError>;
  /**
   * Map validated stored values to the in-memory resolved credentials.
   * `source` distinguishes profile-stored values from CI env resolution.
   */
  readonly toResolved: (values: StoredValues, source: "stored") => Resolved;
  /** CI resolution from env vars; requires {@link environment}. */
  readonly readEnvironment?: Effect.Effect<Resolved, AuthError>;
  readonly environment?: ReadonlyArray<EnvironmentVariable>;
}

/** Inline-values type for factory-made static-token providers. */
export type StoredAuthConfig = {
  readonly method: "stored";
  readonly [key: string]: StoredValue | undefined;
};

/**
 * Validate flag-provided values against the field specs: unknown keys,
 * missing required fields, and per-field validators all fail with an
 * actionable {@link AuthError}.
 */
export const validateFieldValues = (
  provider: string,
  fields: ReadonlyArray<ConfigureField>,
  values: Record<string, string>,
): Effect.Effect<StoredValues, AuthError> =>
  Effect.gen(function* () {
    const known = new Set(fields.map((field) => field.name));
    for (const key of Object.keys(values)) {
      if (!known.has(key)) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `${provider}: unknown field '${key}'. ` +
              `Valid fields: ${[...known].join(", ")}.`,
          }),
        );
      }
    }
    const collected: StoredValues = {};
    for (const field of fields) {
      const raw = values[field.name] ?? field.defaultValue;
      if (raw === undefined || raw.length === 0) {
        if (field.optional) continue;
        return yield* Effect.fail(
          new AuthError({
            message: `${provider}: missing required field '${field.name}' (${field.label}). Pass it with --set ${field.name}=<value>.`,
          }),
        );
      }
      const invalid = field.validate?.(raw);
      if (invalid !== undefined) {
        return yield* Effect.fail(
          new AuthError({
            message: `${provider}: invalid '${field.name}': ${invalid}`,
          }),
        );
      }
      collected[field.name] = field.secret ? Redacted.make(raw) : raw;
    }
    return collected;
  });

/**
 * Prompt for each field in order (secret fields masked, optional fields
 * skippable with an empty answer). Shared by the factory's interactive
 * `configure` and by hand-rolled multi-method providers that want the same
 * behavior for their token method.
 */
export const collectFieldValues = (
  fields: ReadonlyArray<ConfigureField>,
): Effect.Effect<StoredValues, AuthError, Interaction.Interaction> =>
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    const values: StoredValues = {};
    for (const field of fields) {
      const description = [
        field.description,
        field.optional ? "Optional — press Enter to skip." : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      const validate = (value: string) => {
        if (value.length === 0) return field.optional ? undefined : "Required";
        return field.validate?.(value);
      };
      const request = field.secret
        ? interaction.prompt.password({
            message: field.label,
            description: description || undefined,
            placeholder: field.placeholder,
            validate,
          })
        : interaction.prompt.text({
            message: field.label,
            description: description || undefined,
            placeholder: field.placeholder,
            defaultValue: field.defaultValue,
            validate,
          });
      const answer = yield* request.pipe(mapPromptCancellation);
      if (answer.length === 0 && field.optional) continue;
      values[field.name] = field.secret ? Redacted.make(answer) : answer;
    }
    return values;
  });

/**
 * Build a registration Layer (plus the derived inline-values schema)
 * for a single-method stored-credential provider.
 *
 * ```ts
 * export const { layer: NeonAuth, storedSchema: NeonStoredCredentials } =
 *   makeStoredAuthProvider({
 *     provider: "Neon",
 *     fields: [{ name: "apiKey", label: "Neon API Key", secret: true }],
 *     toResolved: (values, source) => ({ ... }),
 *     readEnvironment: ...,
 *     environment: [...],
 *   });
 * ```
 */
export const makeStoredAuthProvider = <Resolved>(
  config: StoredAuthProviderConfig<Resolved>,
) => {
  const { provider, fields } = config;

  const fieldSchemas = Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.optional ? Schema.optional(Schema.String) : Schema.String,
    ]),
  );

  const storedSchema = Schema.Struct(
    fieldSchemas,
    // SAFETY: each generated property schema corresponds exactly to the
    // ConfigureField entry used to construct StoredValues above.
  ) as Schema.Codec<StoredValues>;

  const configSchema = Schema.Struct({
    method: Schema.Literal("stored"),
    ...fieldSchemas,
  }) as Schema.Codec<StoredAuthConfig>;

  const layer = AuthProviderLayer<StoredAuthConfig, Resolved>()(
    provider,
    Effect.gen(function* () {
      const interaction = Interaction.accessors;
      const persist = (_profileName: string, values: StoredValues) =>
        Effect.gen(function* () {
          const complete = config.complete?.(values) ?? Effect.succeed(values);
          const completed = yield* complete;
          yield* interaction.output.success(`${provider}: credentials saved.`);
          return {
            method: "stored" as const,
            ...Object.fromEntries(
              Object.entries(completed).map(([key, value]) => [
                key,
                storedValueText(value),
              ]),
            ),
          };
        });

      const configure = (profileName: string) =>
        collectFieldValues(fields).pipe(
          Effect.flatMap((values) => persist(profileName, values)),
        );

      const configureWith = (
        profileName: string,
        input: { method: string; values: Record<string, string> },
      ) =>
        input.method === "stored"
          ? validateFieldValues(provider, fields, input.values).pipe(
              Effect.flatMap((values) => persist(profileName, values)),
            )
          : Effect.fail(
              new AuthError({
                message: `${provider}: unknown method '${input.method}'. Valid methods: stored.`,
              }),
            );

      const read = (_profileName: string, values: StoredAuthConfig) =>
        Effect.succeed(config.toResolved(values, "stored"));

      const login = (_profileName: string, values: StoredAuthConfig) =>
        Effect.succeed(values);

      const logout = (_profileName: string, _config: StoredAuthConfig) =>
        Effect.void;

      const details = (_profileName: string, values: StoredAuthConfig) =>
        Effect.succeed({
          lines: fields.flatMap((field) => {
            const value = values[field.name];
            if (value === undefined) return [];
            return [
              {
                key: field.name,
                value: field.secret
                  ? displayRedacted(storedSecret(value) ?? Redacted.make(""))
                  : (storedValueText(value) ?? ""),
              },
            ];
          }),
        });

      const configureMethods: ReadonlyArray<ConfigureMethod> = [
        { method: "stored", fields },
      ];

      return {
        configSchema,
        configure,
        configureWith,
        configureMethods,
        login,
        logout,
        details,
        read,
        readEnvironment: config.readEnvironment,
        environment: config.environment,
      };
    }),
  );

  return { layer, storedSchema };
};
