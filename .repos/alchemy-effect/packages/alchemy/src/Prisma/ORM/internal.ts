// Shared scaffolding for the Prisma ORM v8 deploy-time resources.
// NOT exported from the ORM index — service-internal only.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { exec } from "../../Util/exec.ts";

/**
 * A structured failure from the `prisma` CLI.
 *
 * In `--json` mode the CLI streams newline-delimited events and closes with
 * a `{ kind: "result", envelope }` document. A failed envelope carries a
 * stable `code` (e.g. `CONFIG.FILE_NOT_FOUND`, `CONTRACT.VERIFY_FAILED`)
 * plus human guidance in `summary`/`why`/`nextActions`. Those fields are
 * surfaced verbatim so callers can match on `code` and users get the CLI's
 * own remediation text.
 */
export class CliError extends Data.TaggedError("Prisma.CliError")<{
  /** Stable machine code reported by the CLI (e.g. `CONTRACT.VERIFY_FAILED`). */
  code?: string | undefined;
  message: string;
  /** The CLI's suggested remediation, when it reported one. */
  fix?: string | undefined;
  /** Extra structured detail from the CLI (e.g. host/port on connection errors). */
  meta?: Record<string, unknown> | undefined;
}> {}

/**
 * Connection-flavored failures worth retrying: a database that was
 * provisioned earlier in the same deploy may not be accepting connections
 * yet (eventual consistency), so `Prisma.Migrate` retries these briefly.
 */
export const isTransientDbError = (error: CliError): boolean => {
  if (error.code === "DRIVER.CONNECTION_FAILED") return true;
  const meta = error.meta ?? {};
  // The CLI reports the driver's errno under `sqlState` for connection
  // failures (`ECONNREFUSED`, ...) and a real SQLSTATE for statement ones.
  const errno = [meta.sqlState, meta.code].find(
    (value) => typeof value === "string",
  );
  return (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ].includes(errno as string) ||
    /connection|timeout|reachable/i.test(error.message)
  );
};

/**
 * Resolve the unified `prisma` CLI entrypoint (`prisma` v8 mounts the ORM
 * commands — `contract emit`, `migration plan`, `db migrate` — that the
 * retired `prisma-next` bin used to serve). The package is an optional peer,
 * so it resolves out of the *user's* project and their pinned CLI version is
 * the one that runs.
 */
export const resolvePrismaCliBin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = yield* Effect.try({
    try: () => import.meta.resolve("prisma/package.json"),
    catch: (cause) =>
      new CliError({
        message: `Failed to resolve the "prisma" CLI (is it installed? \`npm i -D prisma\`): ${cause}`,
      }),
  });
  const manifestPath = yield* Effect.try({
    try: () => new URL(url),
    catch: (cause) =>
      new CliError({
        message: `Failed to parse the "prisma" package URL: ${cause}`,
      }),
  }).pipe(
    Effect.flatMap((fileUrl) =>
      path.fromFileUrl(fileUrl).pipe(
        Effect.mapError(
          (cause) =>
            new CliError({
              message: `Failed to convert the "prisma" package URL to a path: ${cause}`,
            }),
        ),
      ),
    ),
  );
  const manifest = yield* fs.readFileString(manifestPath).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () =>
          JSON.parse(text) as { bin?: Record<string, string> | string },
        catch: (cause) =>
          new CliError({
            message: `Failed to parse ${manifestPath}: ${cause}`,
          }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof CliError
        ? cause
        : new CliError({ message: `Failed to read ${manifestPath}: ${cause}` }),
    ),
  );
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.prisma;
  if (bin === undefined) {
    return yield* Effect.fail(
      new CliError({
        message: `The installed "prisma" package declares no \`prisma\` bin (${manifestPath}).`,
      }),
    );
  }
  return path.resolve(path.dirname(manifestPath), bin);
});

/** The CLI's failure payload (`envelope.error` in `--json` mode). */
interface CliFailure {
  code?: string;
  severity?: string;
  summary?: string;
  why?: string;
  nextActions?: Array<{ kind?: string; label?: string }>;
  meta?: Record<string, unknown>;
  docsUrl?: string;
}

/**
 * The terminal `{ kind: "result" }` event the CLI closes a `--json` run
 * with. `ok` discriminates the payload: `result` for success, `error` for
 * failure.
 */
interface CliEnvelope {
  ok: boolean;
  commandId?: string;
  result?: unknown;
  error?: CliFailure;
  exitCode?: number;
  nextActions?: Array<{ kind?: string; label?: string }>;
}

/**
 * Scan the CLI's newline-delimited JSON stream for the terminal result
 * envelope. Progress events (`step-started`, `step-finished`, ...) and any
 * non-JSON banner lines are skipped.
 */
const parseEnvelope = (stdout: string): CliEnvelope | undefined => {
  let envelope: CliEnvelope | undefined;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let event: { kind?: string; envelope?: CliEnvelope };
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (event.kind === "result" && event.envelope !== undefined) {
      envelope = event.envelope;
    }
  }
  return envelope;
};

/**
 * Run a `prisma` subcommand with `--json --no-interactive` from `cwd` (the
 * directory containing `prisma.config.ts` — all config-relative paths
 * resolve against it, matching a user running the CLI in their project) and
 * parse the structured result envelope.
 */
export const runPrismaCli = <T>(
  args: readonly string[],
  options: { readonly cwd: string },
): Effect.Effect<
  T,
  CliError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const bin = yield* resolvePrismaCliBin;
    const nodeExecPath = yield* Effect.sync(() => process.execPath);
    const result = yield* exec(
      ChildProcess.make(
        nodeExecPath,
        [bin, ...args, "--json", "--no-interactive"],
        {
          cwd: options.cwd,
          env: { PRISMA_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
          extendEnv: true,
        },
      ),
    ).pipe(
      // exec fully drains stdout/stderr and the exit code before returning,
      // so the process handle's scope can close right here.
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new CliError({
            message: `prisma ${args.slice(0, 2).join(" ")} failed to spawn: ${String(cause)}`,
          }),
      ),
    );

    const envelope = yield* Effect.sync(() => parseEnvelope(result.stdout));

    if (envelope?.ok === true) {
      return envelope.result as T;
    }
    if (envelope?.ok === false) {
      const error = envelope.error ?? {};
      const fix = (error.nextActions ?? envelope.nextActions ?? []).find(
        (action) => typeof action.label === "string",
      )?.label;
      return yield* Effect.fail(
        new CliError({
          code: error.code,
          message: `prisma ${args.slice(0, 2).join(" ")} failed: ${[error.summary, error.why].filter(Boolean).join(" — ") || "unknown error"}`,
          fix,
          meta: error.meta,
        }),
      );
    }
    return yield* Effect.fail(
      new CliError({
        message: `prisma ${args.slice(0, 2).join(" ")} failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`,
      }),
    );
  });

/** `prisma contract emit --json` result. */
export interface EmitResult {
  ok: true;
  /** Canonical hash of the emitted contract's storage shape — the contract identity the migration graph and DB marker track. */
  storageHash: string;
  /** Only emitted for TypeScript-authored contracts. */
  executionHash?: string;
  profileHash: string;
  outDir: string;
  files: { json: string; dts: string };
}

/** `prisma migration plan --json` result. */
export interface PlanResult {
  ok: true;
  noOp: boolean;
  from: string | null;
  to: string;
  /** cwd-relative directory of the written migration package (absent when `noOp`). */
  dir?: string;
  /** True when the plan wrote `placeholder(...)` sentinels that need a human decision. */
  pendingPlaceholders?: boolean;
  operations: Array<{ id: string; label: string; operationClass: string }>;
}

/** `prisma db migrate --json` result. */
export interface MigrateResult {
  ok: true;
  migrationsApplied: number;
  migrationsTotal: number;
  /** The DB marker's contract hash after the run. */
  markerHash: string;
  applied: Array<{
    spaceId: string;
    dirName: string;
    migrationHash: string;
    from: string;
    to: string;
  }>;
}

/** `prisma db migrate --show --json` result (read-only preview). */
export interface MigrateShowResult {
  ok: true;
  migrations: Array<{
    spaceId: string;
    dirName: string;
    migrationHash: string;
    from: string;
    to: string;
  }>;
}

/**
 * Prisma ORM v8 bug workaround (through 8.0.0-rc.8): `contract emit` writes
 * the Prisma monorepo's `@internal/*` aliases into `contract.d.ts` instead of
 * the public `@prisma/orm-*` packages. Those packages are not published, so
 * the emitted types would not resolve in a user project.
 * Longest-prefix-first so `sql-contract` is not eaten by `contract`.
 * `@internal/extension-<name>/` maps to `@prisma/orm-extension-<name>/`.
 */
const INTERNAL_SPECIFIER_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["@internal/adapter-postgres/", "@prisma/orm-postgres/adapter/"],
  ["@internal/target-postgres/", "@prisma/orm-postgres/target/"],
  ["@internal/sql-contract/", "@prisma/orm-postgres/family-contract/"],
  ["@internal/contract/", "@prisma/orm-postgres/contract/"],
  ["@internal/extension-", "@prisma/orm-extension-"],
];

/**
 * Rewrite leaked `@internal/*` specifiers in an emitted `contract.d.ts` to
 * their public `@prisma/orm-*` equivalents. A no-op for PSL-authored emits
 * (which never contain them); fails actionably if an unmapped `@internal/*`
 * specifier remains.
 */
export const rewriteEmittedTypes = (dtsPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(dtsPath);
    if (!exists) return;
    const original = yield* fs.readFileString(dtsPath);
    if (!original.includes("@internal/")) return;
    let rewritten = original;
    for (const [internal, publicPrefix] of INTERNAL_SPECIFIER_REWRITES) {
      rewritten = rewritten.replaceAll(internal, publicPrefix);
    }
    if (rewritten.includes("@internal/")) {
      const leftover = rewritten
        .split("\n")
        .find((line) => line.includes("@internal/"));
      return yield* Effect.fail(
        new CliError({
          message: [
            `Emitted ${dtsPath} references an unpublished @internal/* module this`,
            `integration does not know how to map yet: ${leftover?.trim()}`,
            "Please report this — the emitted types will not resolve until it is mapped.",
          ].join("\n"),
        }),
      );
    }
    yield* fs.writeFileString(dtsPath, rewritten);
  });

/**
 * One on-disk migration package under `{migrationsDir}/app/`.
 *
 * `opsEmpty` distinguishes a fully-emitted package (`ops.json` holds the
 * rendered operations) from one still carrying unfilled `placeholder(...)`
 * closures — `migration plan` writes `ops.json` as `[]` until the user edits
 * `migration.ts` and self-emits it.
 */
export interface MigrationPackage {
  dirName: string;
  from: string | null;
  to: string;
  migrationHash: string;
  opsEmpty: boolean;
}

/**
 * Read every migration package in the app contract space, sorted by
 * directory name (timestamp-prefixed).
 */
export const readMigrationPackages = (migrationsDirAbs: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appDir = path.join(migrationsDirAbs, "app");
    const exists = yield* fs.exists(appDir);
    if (!exists) return [] as MigrationPackage[];
    const entries = (yield* fs.readDirectory(appDir)).sort();
    const packages: MigrationPackage[] = [];
    for (const dirName of entries) {
      const metaPath = path.join(appDir, dirName, "migration.json");
      const hasMeta = yield* fs.exists(metaPath);
      if (!hasMeta) continue;
      const meta = yield* fs.readFileString(metaPath).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () =>
              JSON.parse(text) as {
                from: string | null;
                to: string;
                migrationHash: string;
              },
            catch: (cause) =>
              new CliError({
                message: `Failed to parse ${metaPath}: ${cause}`,
              }),
          }),
        ),
      );
      const opsPath = path.join(appDir, dirName, "ops.json");
      const hasOps = yield* fs.exists(opsPath);
      const opsText = hasOps ? yield* fs.readFileString(opsPath) : "[]";
      packages.push({
        dirName,
        from: meta.from,
        to: meta.to,
        migrationHash: meta.migrationHash,
        opsEmpty: opsText.trim() === "[]" || opsText.trim() === "",
      });
    }
    return packages;
  });

/**
 * Resolve the head of the migration graph: the `to` hash no other package
 * plans *from*. Directory-name order breaks ties (branchy graphs from
 * merges); an empty graph has no head.
 */
export const resolveGraphHead = (
  packages: readonly MigrationPackage[],
): MigrationPackage | undefined => {
  const froms = new Set(
    packages.flatMap((pkg) => (pkg.from === null ? [] : [pkg.from])),
  );
  const heads = packages.filter((pkg) => !froms.has(pkg.to));
  return heads.at(-1);
};
