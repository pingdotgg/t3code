import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Redacted from "effect/Redacted";
import * as Provider from "../Provider.ts";
import {
  DEV_TIMESTAMP,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { EnvironmentVariable as ApiEnvironmentVariable } from "./Types.ts";

export interface EnvironmentVariableProps {
  /**
   * Project ID or `project.projectId` output that owns this variable.
   */
  project: string | Project;
  /**
   * Preview branch ID for a branch override. Omit for project-level templates.
   */
  branchId?: string;
  /**
   * Environment variable class.
   */
  class: "production" | "preview";
  /**
   * Environment variable key.
   */
  key: string;
  /**
   * Secret value. Must be wrapped with `Redacted.make(...)` so the engine
   * redacts it before resource props are persisted to state.
   */
  value: Redacted.Redacted<string>;
}

export interface EnvironmentVariable extends Resource<
  "Prisma.EnvironmentVariable",
  EnvironmentVariableProps,
  {
    /**
     * Prisma environment variable ID.
     */
    environmentVariableId: string;
    /**
     * Project ID that owns the variable.
     */
    projectId: string;
    /**
     * Branch ID for branch overrides, or null for project templates.
     */
    branchId: string | null;
    /**
     * Environment variable class.
     */
    class: "production" | "preview";
    /**
     * Environment variable key.
     */
    key: string;
    /**
     * Secret value, redacted in state.
     */
    value: Redacted.Redacted<string>;
    /**
     * Key identifier for the encrypted stored value.
     */
    valueKid: string;
    /**
     * Whether Prisma manages this variable internally.
     */
    isManagedBySystem: boolean;
    /**
     * ISO timestamp when the variable was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the variable was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma compute environment variable.
 *
 * Values are write-only in Prisma. Alchemy stores them as `Redacted` values
 * and reapplies the desired value to repair drift.
 *
 * ### Creating a Variable
 * **Example:** Project-level production variable
 * ```typescript
 * yield* Prisma.EnvironmentVariable("api-url", {
 *   project: project.projectId,
 *   // No branchId: this is a project-level template.
 *   class: "production",
 *   key: "API_URL",
 *   value: Redacted.make("https://api.example.com"),
 * });
 * ```
 *
 * **Example:** Preview branch override
 * ```typescript
 * yield* Prisma.EnvironmentVariable("preview-api-url", {
 *   project,
 *   branchId: preview.branchId,
 *   // Branch overrides always use the preview class.
 *   class: "preview",
 *   key: "API_URL",
 *   value: Redacted.make("https://preview.example.com"),
 * });
 * ```
 *
 * @resource
 */
export const EnvironmentVariable = Resource<EnvironmentVariable>(
  "Prisma.EnvironmentVariable",
);

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENV_VALUE_MAX_BYTES = 8 * 1024;

const validateEnvironmentVariableKey = (key: string) =>
  Effect.gen(function* () {
    if (key.length < 1 || key.length > 256 || !ENV_KEY_PATTERN.test(key)) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable key '${key}' must match POSIX env-var key shape: [A-Z_][A-Z0-9_]* and be at most 256 characters.`,
        ),
      );
    }
  });

const validateEnvironmentVariableWrite = (
  key: string,
  value: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    yield* validateEnvironmentVariableKey(key);
    const raw = Redacted.value(value);
    if (raw.length === 0) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value must be non-empty.`,
        ),
      );
    }
    const byteLength = yield* Effect.sync(
      () => new TextEncoder().encode(raw).byteLength,
    );
    if (byteLength > ENV_VALUE_MAX_BYTES) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value exceeds ${ENV_VALUE_MAX_BYTES} bytes.`,
        ),
      );
    }
  });

const findVariable = (
  client: PrismaManagementClient,
  projectId: string,
  cls: "production" | "preview",
  key: string,
  branchId?: string | null,
) =>
  client
    .listEnvironmentVariables({
      projectId,
      class: cls,
      key,
      ...(branchId ? { branchId } : {}),
      limit: 100,
    })
    .pipe(
      Effect.flatMap((variables) => {
        const matches = variables.filter(
          (variable) => variable.branchId === (branchId ?? null),
        );
        return matches.length > 1
          ? Effect.fail(
              new Error(
                `Multiple Prisma environment variables match '${key}' in the requested scope; refusing to select one arbitrarily.`,
              ),
            )
          : Effect.succeed(matches[0]);
      }),
    );

const attrsFrom = (
  variable: ApiEnvironmentVariable,
  value: Redacted.Redacted<string>,
): EnvironmentVariable["Attributes"] => ({
  environmentVariableId: variable.id,
  projectId: variable.projectId,
  branchId: variable.branchId,
  class: variable.class,
  key: variable.key,
  value,
  valueKid: variable.valueKid,
  isManagedBySystem: variable.isManagedBySystem,
  createdAt: variable.createdAt,
  updatedAt: variable.updatedAt,
});

const systemManagedVariableError = (key: string) =>
  new Error(
    `Prisma environment variable '${key}' is managed by Prisma and cannot be managed by Alchemy.`,
  );

const ensureUserManagedVariable = (variable: ApiEnvironmentVariable) =>
  Effect.gen(function* () {
    if (variable.isManagedBySystem) {
      return yield* Effect.fail(systemManagedVariableError(variable.key));
    }
  });

const ensureVariableIdentity = (
  variable: ApiEnvironmentVariable,
  expected: {
    projectId: string;
    branchId: string | null;
    class: "production" | "preview";
    key: string;
  },
) =>
  variable.projectId === expected.projectId &&
  variable.branchId === expected.branchId &&
  variable.class === expected.class &&
  variable.key === expected.key
    ? Effect.void
    : Effect.fail(
        new Error(
          `Prisma environment variable '${variable.id}' has immutable identity project '${variable.projectId}', branch '${variable.branchId ?? "null"}', class '${variable.class}', key '${variable.key}', but this resource requires project '${expected.projectId}', branch '${expected.branchId ?? "null"}', class '${expected.class}', key '${expected.key}'. Refusing to update or delete a mismatched secret.`,
        ),
      );

const ProviderLive = () =>
  Provider.effect(
    EnvironmentVariable,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["environmentVariableId"],
        list: () =>
          client.listEnvironmentVariables().pipe(
            Effect.map((variables) =>
              variables
                // System-managed variables are project-owned and cannot be
                // deleted through this API.
                .filter((variable) => !variable.isManagedBySystem)
                .map((variable) =>
                  // The API deliberately never returns plaintext. `delete`
                  // needs only identity/metadata, so nuke uses an impossible
                  // empty placeholder rather than pretending to know a secret.
                  attrsFrom(variable, Redacted.make("")),
                ),
            ),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.environmentVariableId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (isResolved(news.branchId) && news.branchId !== olds.branchId) ||
            (isResolved(news.class) && news.class !== olds.class) ||
            (isResolved(news.key) && news.key !== olds.key)
          ) {
            return { action: "replace" } as const;
          }
          // Values are write-only: the Management API never returns
          // plaintext, so equality with `olds` cannot prove the live secret
          // is still correct. Re-apply every resolved desired value to heal
          // out-of-band secret drift on ordinary deploys.
          if (isResolved(news.value)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const variableId = isPrismaDevId(output?.environmentVariableId)
            ? undefined
            : output?.environmentVariableId;
          const variable = variableId
            ? yield* client
                .getEnvironmentVariable(variableId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findVariable(
                      client,
                      projectId,
                      olds.class,
                      olds.key,
                      olds.branchId,
                    )
                  : undefined;
              });
          if (!variable) return undefined;
          const attrs = attrsFrom(
            variable,
            // A cold read cannot observe the secret. Never copy the desired
            // value into output: doing so would make the forced adoption
            // reconcile falsely conclude the cloud already contains it.
            output?.value ?? Redacted.make(""),
          );
          return variableId === undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          if (news.branchId !== undefined && news.class !== "preview") {
            return yield* Effect.fail(
              new Error(
                'Prisma branch-scoped environment variables must use class: "preview".',
              ),
            );
          }
          yield* validateEnvironmentVariableWrite(news.key, news.value);
          const projectId = yield* resolveProjectId(news.project);
          const variableId = isPrismaDevId(output?.environmentVariableId)
            ? undefined
            : output?.environmentVariableId;
          let variable = variableId
            ? yield* client
                .getEnvironmentVariable(variableId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : undefined;
          const value = news.value;
          let created = false;
          if (!variable) {
            const result = yield* client
              .createEnvironmentVariable({
                projectId,
                ...(news.branchId ? { branchId: news.branchId } : {}),
                class: news.class,
                key: news.key,
                value: Redacted.value(value),
              })
              .pipe(
                Effect.map((variable) => ({ variable, created: true })),
                Effect.catchIf(isConflict, () =>
                  Effect.fail(
                    new Error(
                      `Prisma environment variable '${news.key}' appeared after the adoption check. Refusing to overwrite its secret; rerun with adoption enabled if it is the intended variable.`,
                    ),
                  ),
                ),
              );
            variable = result.variable;
            created = result.created;
          }
          yield* ensureVariableIdentity(variable, {
            projectId,
            branchId: news.branchId ?? null,
            class: news.class,
            key: news.key,
          });
          yield* ensureUserManagedVariable(variable);
          if (!created) {
            variable = yield* client.updateEnvironmentVariable(variable.id, {
              value: Redacted.value(value),
            });
          }
          return attrsFrom(variable, value);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (isPrismaDevId(output.environmentVariableId)) return;
          const variable = yield* client
            .getEnvironmentVariable(output.environmentVariableId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!variable) return;
          yield* ensureVariableIdentity(variable, {
            projectId: output.projectId,
            branchId: output.branchId,
            class: output.class,
            key: output.key,
          });
          if (variable.isManagedBySystem) {
            // Prisma-owned environment variables are provider-managed system
            // state and are not deletable through this resource lifecycle.
            if (session !== undefined) {
              yield* session.note(
                `Skipping direct delete for system-managed Prisma environment variable '${variable.key}'.`,
              );
            }
            return;
          }
          yield* client
            .deleteEnvironmentVariable(variable.id)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(
    EnvironmentVariable,
    ["environmentVariableId"],
    ({ id, news }) => ({
      environmentVariableId: devId("environment-variable", id),
      projectId: attrOrString(news.project, "projectId"),
      branchId: news.branchId ?? null,
      class: news.class,
      key: news.key,
      value: news.value,
      valueKid: devId("value-kid", id),
      isManagedBySystem: false,
      createdAt: DEV_TIMESTAMP,
      updatedAt: DEV_TIMESTAMP,
    }),
  );

export const EnvironmentVariableProvider = () =>
  ProviderLayer.dual(EnvironmentVariable, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
