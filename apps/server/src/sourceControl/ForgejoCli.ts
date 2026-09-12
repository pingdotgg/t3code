import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { SourceControlProviderContext } from "./SourceControlProvider.ts";

const encodeApiBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class ForgejoCliError extends Schema.TaggedError<ForgejoCliError>()("ForgejoCliError", {
  command: Schema.Literal("tea"),
  cwd: Schema.String,
  detail: Schema.String,
  reason: Schema.optional(
    Schema.Literals([
      "missing-cli",
      "authentication",
      "forbidden",
      "not-found",
      "rate-limit",
      "invalid-response",
    ]),
  ),
  httpStatus: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {}

export const ForgejoLoginSchema = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  ssh_host: Schema.optional(Schema.String),
  valid: Schema.optional(Schema.String),
  user: Schema.String,
  default: Schema.String,
});

export function parseForgejoLogins(raw: string) {
  const decoded = decodeJsonResult(Schema.Array(ForgejoLoginSchema))(raw);
  return Result.isSuccess(decoded) ? decoded.success : [];
}

export interface ForgejoRepositoryInput {
  readonly cwd: string;
  readonly context?: SourceControlProviderContext;
  readonly repository?: string;
  readonly reference?: string;
  readonly host?: string;
}

export interface ForgejoRepository {
  readonly login: string;
  readonly repository: string;
  readonly baseUrl: string;
}

export interface ForgejoApiInput extends ForgejoRepositoryInput {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
}

export class ForgejoCli extends Context.Service<
  ForgejoCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, ForgejoCliError>;
    readonly resolveRepository: (
      input: ForgejoRepositoryInput,
    ) => Effect.Effect<ForgejoRepository, ForgejoCliError>;
    readonly api: (
      input: ForgejoApiInput,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, ForgejoCliError>;
  }
>()("t3/sourceControl/ForgejoCli") {}

export function parseForgejoRemote(value: string) {
  if (/^(?:https?|ssh):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return {
        host: url.host.toLowerCase(),
        hostname: url.hostname.toLowerCase(),
        ssh: url.protocol === "ssh:",
        path: url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""),
      };
    } catch {
      return null;
    }
  }
  // SCP remotes may omit the username; URL treats these as a custom scheme.
  const ssh = /^(?:[^@/]+@)?([^:/]+):([^/].*)$/.exec(value);
  return ssh?.[1] && ssh[2]
    ? {
        host: ssh[1].toLowerCase(),
        hostname: ssh[1].toLowerCase(),
        ssh: true,
        path: ssh[2].replace(/\.git$/, ""),
      }
    : null;
}

export function matchForgejoLogin(
  logins: ReturnType<typeof parseForgejoLogins>,
  remote: NonNullable<ReturnType<typeof parseForgejoRemote>>,
  requestedHost?: string,
) {
  const matches = logins.filter((login) => {
    const url = parseForgejoRemote(login.url);
    if (!url) return false;
    if (requestedHost !== undefined && url.host !== requestedHost.toLowerCase()) return false;
    return remote.ssh
      ? login.ssh_host?.toLowerCase() === remote.hostname || url.hostname === remote.hostname
      : url.host === remote.host &&
          (!url.path || remote.path === url.path || remote.path.startsWith(`${url.path}/`));
  });
  return matches.length === 1
    ? matches[0]
    : new Set(matches.map((login) => login.url)).size === 1
      ? matches.find((login) => login.default === "true")
      : undefined;
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const execute: ForgejoCli["Service"]["execute"] = (input) =>
    process
      .run({
        ...input,
        operation: "ForgejoCli.execute",
        command: "tea",
        timeoutMs: input.timeoutMs ?? 30_000,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ForgejoCliError({
              command: "tea",
              cwd: input.cwd,
              cause,
              ...(cause._tag === "VcsProcessSpawnError"
                ? { reason: "missing-cli" as const }
                : cause._tag === "VcsProcessExitError" && cause.failureKind === "authentication"
                  ? { reason: "authentication" as const }
                  : {}),
              detail:
                cause._tag === "VcsProcessSpawnError"
                  ? "Install the official Gitea CLI (`tea` 0.16 or later) and retry."
                  : cause._tag === "VcsProcessExitError" && cause.failureKind === "authentication"
                    ? "Run `tea login add` to authenticate this Forgejo server."
                    : "Forgejo CLI command failed.",
            }),
        ),
      );

  const resolveRepository = Effect.fn("ForgejoCli.resolveRepository")(function* (
    input: ForgejoRepositoryInput,
  ) {
    const logins = parseForgejoLogins(
      (yield* execute({ cwd: input.cwd, args: ["login", "list", "--output", "json"] })).stdout,
    );
    const referenceRemote = input.reference ? parseForgejoRemote(input.reference) : null;
    let remote =
      referenceRemote ??
      (input.repository ? parseForgejoRemote(input.repository) : null) ??
      (input.context ? parseForgejoRemote(input.context.remoteUrl) : null);
    if (!remote && (!input.repository || input.host)) {
      const result = yield* process
        .run({
          operation: "ForgejoCli.remote",
          command: "git",
          args: ["remote", "get-url", "origin"],
          cwd: input.cwd,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoCliError({
                command: "tea",
                cwd: input.cwd,
                detail: "Could not resolve the Forgejo repository remote.",
                cause,
              }),
          ),
        );
      remote = parseForgejoRemote(result.stdout.trim());
    }
    if (
      input.host &&
      !remote?.ssh &&
      remote?.host !== input.host.toLowerCase() &&
      remote?.hostname !== input.host.toLowerCase()
    )
      remote = {
        host: input.host.toLowerCase(),
        hostname: input.host.split(":")[0] ?? input.host,
        ssh: false,
        path: remote?.path ?? "",
      };
    const login = remote
      ? matchForgejoLogin(logins, remote, remote.ssh ? input.host : undefined)
      : (logins.find((item) => item.default === "true") ??
        (logins.length === 1 ? logins[0] : undefined));
    if (!login)
      return yield* new ForgejoCliError({
        command: "tea",
        cwd: input.cwd,
        reason: "authentication",
        detail:
          "No matching Forgejo login. Run `tea login add` for this server; choose a default when multiple accounts match.",
      });
    const path =
      referenceRemote?.path ??
      (input.repository && !parseForgejoRemote(input.repository)
        ? input.repository
        : remote?.path) ??
      "";
    const basePath = new URL(login.url).pathname.replace(/^\/+|\/+$/g, "");
    const relativePath =
      basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length + 1) : path;
    const repositoryPath = relativePath.replace(/\/pulls\/\d+.*$/, "").replace(/\.git$/, "");
    const repository = repositoryPath.includes("/")
      ? repositoryPath
      : `${login.user}/${repositoryPath}`;
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
      return yield* new ForgejoCliError({
        command: "tea",
        cwd: input.cwd,
        detail: "Specify a Forgejo repository as owner/repository or its full server URL.",
      });
    return { login: login.name, repository, baseUrl: login.url.replace(/\/+$/, "") };
  });
  const api = Effect.fn("ForgejoCli.api")(function* (input: ForgejoApiInput) {
    const repository = yield* resolveRepository(input);
    const stdin =
      input.body === undefined
        ? undefined
        : yield* encodeApiBody(input.body).pipe(
            Effect.mapError(
              (cause) =>
                new ForgejoCliError({
                  command: "tea",
                  cwd: input.cwd,
                  detail: "Could not encode the Forgejo request body.",
                  cause,
                }),
            ),
          );
    let path = input.path.replace(/^\/+/, "");
    if (input.repository && input.repository !== repository.repository) {
      // Repository identities retain the server mount path; API routes do not.
      const prefix = `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
      if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) {
        path = `repos/${repository.repository.split("/").map(encodeURIComponent).join("/")}${path.slice(prefix.length)}`;
      }
    }
    const result = yield* execute({
      cwd: input.cwd,
      args: [
        "api",
        "--include",
        "--login",
        repository.login,
        "--repo",
        repository.repository,
        "--method",
        input.method ?? "GET",
        ...(input.body === undefined ? [] : ["--data", "@-"]),
        `${repository.baseUrl}/api/v1/${path}`,
      ],
      ...(stdin === undefined ? {} : { stdin }),
    });
    // tea reports HTTP failures with exit code zero; use its response status.
    const status = Number(/^HTTP\/\S+ (\d{3})/m.exec(result.stderr)?.[1]);
    if (!status || status >= 400)
      return yield* new ForgejoCliError({
        command: "tea",
        cwd: input.cwd,
        ...(status ? { httpStatus: status } : {}),
        ...(status === 401
          ? { reason: "authentication" as const }
          : status === 403
            ? { reason: "forbidden" as const }
            : status === 404
              ? { reason: "not-found" as const }
              : status === 429
                ? { reason: "rate-limit" as const }
                : {}),
        detail:
          status === 401 || status === 403
            ? "Forgejo denied access. Check this server's `tea login` credentials and permissions."
            : status === 404
              ? "Forgejo repository or pull request was not found."
              : status === 429
                ? "Forgejo API rate limit exceeded."
                : `Forgejo API request failed${status ? ` (HTTP ${status})` : " without an HTTP status"}.`,
      });
    return result;
  });
  return ForgejoCli.of({ execute, resolveRepository, api });
});

export const layer = Layer.effect(ForgejoCli, make);
