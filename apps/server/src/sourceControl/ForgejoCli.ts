import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - fj storage paths use explicit Windows and POSIX layouts, independently of this process's platform.
import * as NodePath from "node:path";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import type { SourceControlProviderContext } from "./SourceControlProvider.ts";

const encodeApiBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class ForgejoCliError extends Schema.TaggedError<ForgejoCliError>()("ForgejoCliError", {
  command: Schema.Literals(["fj", "tea"]),
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

export const ForgejoKeysSchema = Schema.Struct({
  hosts: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.Literals(["Application", "OAuth"]),
      token: Schema.String,
    }),
  ),
  aliases: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const parseForgejoKeys = decodeJsonResult(ForgejoKeysSchema);

/** Matches fj's directories::ProjectDirs, including its pre-0.6 organization name. */
function forgejoKeysPaths(input: {
  readonly platform: string;
  readonly home: string;
  readonly dataHome?: string;
  readonly appData?: string;
}) {
  if (input.platform === "darwin")
    return ["forgejo-cli", "Cyborus"].map((organization) =>
      NodePath.join(
        input.home,
        "Library",
        "Application Support",
        `${organization}.forgejo-cli`,
        "keys.json",
      ),
    );
  if (input.platform === "win32")
    return ["forgejo-cli", "Cyborus"].map((organization) =>
      NodePath.win32.join(
        input.appData || NodePath.win32.join(input.home, "AppData", "Roaming"),
        organization,
        "forgejo-cli",
        "data",
        "keys.json",
      ),
    );
  return [
    NodePath.join(
      input.dataHome && NodePath.isAbsolute(input.dataHome)
        ? input.dataHome
        : NodePath.join(input.home, ".local", "share"),
      "forgejo-cli",
      "keys.json",
    ),
  ];
}

export interface ForgejoRepositoryInput {
  readonly cwd: string;
  readonly context?: SourceControlProviderContext;
  readonly repository?: string;
  readonly reference?: string;
  readonly host?: string;
}

export interface ForgejoRepository {
  readonly command?: "fj" | "tea";
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
      readonly command?: "fj" | "tea";
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, ForgejoCliError>;
    readonly listLogins?: (input: {
      readonly cwd: string;
      readonly command: "fj" | "tea";
      readonly remoteUrl?: string;
    }) => Effect.Effect<ReturnType<typeof parseForgejoLogins>, ForgejoCliError>;
    readonly getAccount?: (input: {
      readonly cwd: string;
      readonly baseUrl: string;
    }) => Effect.Effect<string, ForgejoCliError>;
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
  hostOnly = false,
) {
  const matches = [
    ...new Map(
      logins
        .filter((login) => {
          const url = parseForgejoRemote(login.url);
          if (!url) return false;
          if (requestedHost !== undefined && url.host !== requestedHost.toLowerCase()) return false;
          return remote.ssh
            ? login.ssh_host?.toLowerCase() === remote.host ||
                login.ssh_host?.toLowerCase() === remote.hostname ||
                url.hostname === remote.hostname
            : url.host === remote.host &&
                ((hostOnly && !remote.path) ||
                  !url.path ||
                  remote.path === url.path ||
                  remote.path.startsWith(`${url.path}/`));
        })
        .map((login) => [login.name, login]),
    ).values(),
  ];
  return matches.length === 1
    ? matches[0]
    : new Set(matches.map((login) => login.url)).size === 1
      ? matches.find((login) => login.default === "true")
      : undefined;
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const authLock = yield* Semaphore.make(1);
  const authenticated = new Map<string, { token: string; time: number }>();
  const execute: ForgejoCli["Service"]["execute"] = (input) =>
    process
      .run({
        ...input,
        operation: "ForgejoCli.execute",
        command: input.command ?? "tea",
        timeoutMs: input.timeoutMs ?? 30_000,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ForgejoCliError({
              command: input.command ?? "tea",
              cwd: input.cwd,
              ...(input.command === "fj" ? {} : { cause }),
              ...(cause._tag === "VcsProcessSpawnError"
                ? { reason: "missing-cli" as const }
                : cause._tag === "VcsProcessExitError" && cause.failureKind === "authentication"
                  ? { reason: "authentication" as const }
                  : {}),
              detail:
                cause._tag === "VcsProcessSpawnError"
                  ? "Install Forgejo CLI (`fj` 0.6 or later) or Gitea CLI (`tea` 0.16 or later) and retry."
                  : cause._tag === "VcsProcessExitError" && cause.failureKind === "authentication"
                    ? "Authenticate this server with `fj auth login`, `fj auth add-token`, or `tea login add`."
                    : "Forgejo CLI command failed.",
            }),
        ),
      );

  const readKeys = Effect.fn("ForgejoCli.readKeys")(function* (cwd: string) {
    for (const path of forgejoKeysPaths({
      platform: yield* HostProcessPlatform,
      home: NodeOS.homedir(),
      ...(globalThis.process.env.XDG_DATA_HOME
        ? { dataHome: globalThis.process.env.XDG_DATA_HOME }
        : {}),
      ...(globalThis.process.env.APPDATA ? { appData: globalThis.process.env.APPDATA } : {}),
    })) {
      const exists = yield* fileSystem.exists(path).pipe(
        Effect.mapError(
          () =>
            new ForgejoCliError({
              command: "fj",
              cwd,
              reason: "authentication",
              detail: "Could not read fj authentication storage.",
            }),
        ),
      );
      if (!exists) continue;
      const raw = yield* fileSystem.readFileString(path).pipe(
        Effect.mapError(
          () =>
            new ForgejoCliError({
              command: "fj",
              cwd,
              reason: "authentication",
              detail: "Could not read fj authentication storage.",
            }),
        ),
      );
      const decoded = parseForgejoKeys(raw);
      if (Result.isFailure(decoded))
        return yield* new ForgejoCliError({
          command: "fj",
          cwd,
          reason: "authentication",
          detail: "fj authentication storage is invalid. Authenticate again with fj.",
        });
      return decoded.success;
    }
    const empty: typeof ForgejoKeysSchema.Type = { hosts: {}, aliases: {} };
    return empty;
  });

  const publicLogins = (
    keys: typeof ForgejoKeysSchema.Type,
    remoteUrl?: string,
  ): ReturnType<typeof parseForgejoLogins> => {
    const remote = remoteUrl ? parseForgejoRemote(remoteUrl) : null;
    return Object.keys(keys.hosts).flatMap((host) => {
      const url = parseForgejoRemote(`https://${host}`);
      // fj 0.6 drops URL mounts during whoami and OAuth renewal; tea supports them.
      if (!url || url.path) return [];
      // fj omits the scheme in storage. Only an explicit matching HTTP remote opts into HTTP.
      const scheme =
        remote && !remote.ssh && remote.host === url.host && /^http:\/\//i.test(remoteUrl ?? "")
          ? "http"
          : "https";
      const login = { name: host, url: `${scheme}://${host}`, user: "", default: "false" };
      const aliases = Object.entries(keys.aliases ?? {})
        .filter(([, target]) => target === host)
        .map(([alias]) => ({ ...login, ssh_host: alias }));
      return aliases.length ? aliases : [login];
    });
  };

  const listLogins: NonNullable<ForgejoCli["Service"]["listLogins"]> = Effect.fn(
    "ForgejoCli.listLogins",
  )(function* (input) {
    if (input.command === "fj") {
      const keys = yield* readKeys(input.cwd).pipe(Effect.result);
      if (Result.isFailure(keys)) {
        // Stale credentials from an uninstalled fj must not disable an available tea login.
        const available = yield* execute({ command: "fj", cwd: input.cwd, args: ["version"] }).pipe(
          Effect.result,
        );
        if (Result.isFailure(available) && available.failure.reason === "missing-cli") return [];
        return yield* keys.failure;
      }
      return publicLogins(keys.success, input.remoteUrl);
    }
    return parseForgejoLogins(
      (yield* execute({ cwd: input.cwd, args: ["login", "list", "--output", "json"] })).stdout,
    );
  });

  const requestFj = Effect.fn("ForgejoCli.requestFj")(
    function* (input: {
      readonly cwd: string;
      readonly baseUrl: string;
      readonly token: string;
      readonly path: string;
      readonly method?: ForgejoApiInput["method"];
      readonly body?: string;
    }) {
      const base = new URL(`${input.baseUrl}/api/v1/`);
      const url = new URL(input.path, base);
      if (
        url.origin !== base.origin ||
        !url.pathname.startsWith(base.pathname) ||
        url.username ||
        url.password
      )
        return yield* new ForgejoCliError({
          command: "fj",
          cwd: input.cwd,
          detail: "Invalid Forgejo API path.",
        });
      let request = HttpClientRequest.make(input.method ?? "GET")(url.toString()).pipe(
        HttpClientRequest.setHeader("Authorization", `token ${input.token}`),
      );
      if (input.body !== undefined)
        request = request.pipe(HttpClientRequest.bodyText(input.body, "application/json"));
      const response = yield* httpClient
        .execute(request)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const status = response.status;
      if (status < 200 || status >= 300)
        return yield* new ForgejoCliError({
          command: "fj",
          cwd: input.cwd,
          httpStatus: status,
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
            status === 404
              ? "Forgejo repository or pull request was not found."
              : `Forgejo API request failed (HTTP ${status}). Check this server's fj credentials and permissions.`,
        });
      const body =
        status === 204 || status === 205
          ? { text: "", truncated: false, invalidUtf8: false }
          : yield* collectUint8StreamText({
              stream: response.stream,
              maxBytes: 8 * 1024 * 1024,
            });
      if (body.truncated || body.invalidUtf8)
        return yield* new ForgejoCliError({
          command: "fj",
          cwd: input.cwd,
          reason: "invalid-response",
          detail: "Forgejo returned an oversized or invalid response.",
        });
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: body.text,
        stderr: `HTTP/1.1 ${status}\n${response.headers.link ? `link: ${response.headers.link}\n` : ""}`,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeout(30_000),
        Effect.mapError((error) =>
          error._tag === "ForgejoCliError"
            ? error
            : new ForgejoCliError({
                command: "fj",
                cwd: input.cwd,
                detail: "Forgejo API request failed or timed out.",
              }),
        ),
      ),
  );

  const authenticateFj = Effect.fn("ForgejoCli.authenticateFj")(function* (
    cwd: string,
    login: typeof ForgejoLoginSchema.Type,
  ) {
    const keys = yield* readKeys(cwd);
    const token = keys.hosts[login.name]?.token;
    const now = yield* Clock.currentTimeMillis;
    const cached = authenticated.get(login.url);
    if (token && cached?.token === token && now - cached.time < 30_000) return token;
    yield* execute({ command: "fj", cwd, args: ["--host", login.url, "whoami"] });
    // fj owns OAuth renewal. Re-read the file after it has refreshed an expired token.
    const refreshed = (yield* readKeys(cwd)).hosts[login.name]?.token;
    if (!refreshed)
      return yield* new ForgejoCliError({
        command: "fj",
        cwd,
        reason: "authentication",
        detail: "fj has no credentials for this server. Authenticate again with fj.",
      });
    authenticated.set(login.url, { token: refreshed, time: now });
    return refreshed;
  }, authLock.withPermits(1));

  const getAccount: NonNullable<ForgejoCli["Service"]["getAccount"]> = Effect.fn(
    "ForgejoCli.getAccount",
  )(function* (input) {
    const logins = yield* listLogins({ cwd: input.cwd, command: "fj", remoteUrl: input.baseUrl });
    const login = logins.find(
      (item) => item.url.replace(/\/+$/, "") === input.baseUrl.replace(/\/+$/, ""),
    );
    if (!login)
      return yield* new ForgejoCliError({
        command: "fj",
        cwd: input.cwd,
        reason: "authentication",
        detail: "fj has no credentials for this server.",
      });
    const token = yield* authenticateFj(input.cwd, login);
    const currentUser = yield* requestFj({
      cwd: input.cwd,
      baseUrl: login.url.replace(/\/+$/, ""),
      token,
      path: "user",
    });
    const user = decodeJsonResult(Schema.Struct({ login: Schema.String }))(currentUser.stdout);
    if (Result.isFailure(user) || !user.success.login.trim())
      return yield* new ForgejoCliError({
        command: "fj",
        cwd: input.cwd,
        reason: "invalid-response",
        detail: "Forgejo returned an invalid account response.",
      });
    return user.success.login;
  });

  const resolveTarget = Effect.fn("ForgejoCli.resolveTarget")(function* (
    input: ForgejoRepositoryInput,
    hostOnly = false,
  ) {
    const referenceRemote = input.reference ? parseForgejoRemote(input.reference) : null;
    let remoteUrl = [input.reference, input.repository, input.context?.remoteUrl].find(
      (value) => value && parseForgejoRemote(value),
    );
    let remote =
      referenceRemote ??
      (input.repository ? parseForgejoRemote(input.repository) : null) ??
      (input.context ? parseForgejoRemote(input.context.remoteUrl) : null);
    if (!remote && (!input.repository || input.host)) {
      const result = yield* process
        .run({
          operation: "ForgejoCli.remote",
          command: "git",
          args: input.host ? ["remote", "-v"] : ["remote", "get-url", "origin"],
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
      if (input.host) {
        const matchingUrls = [
          ...new Set(
            result.stdout.split("\n").flatMap((line) => {
              const url = /^\S+\s+(https?:\/\/\S+)\s+\(fetch\)$/.exec(line.trim())?.[1];
              return url && parseForgejoRemote(url)?.host === input.host?.toLowerCase()
                ? [url]
                : [];
            }),
          ),
        ];
        const origins = [...new Set(matchingUrls.map((url) => new URL(url).origin))];
        remoteUrl =
          matchingUrls.length === 1
            ? matchingUrls[0]
            : origins.length === 1
              ? origins[0]
              : undefined;
      } else {
        remoteUrl = result.stdout.trim();
      }
      remote = remoteUrl ? parseForgejoRemote(remoteUrl) : null;
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
    const schemeRemoteUrl = remote?.ssh ? input.context?.provider.baseUrl : remoteUrl;
    const fjLogins = yield* listLogins({
      cwd: input.cwd,
      command: "fj",
      ...(schemeRemoteUrl ? { remoteUrl: schemeRemoteUrl } : {}),
    });
    const requestedHost = input.host ?? input.context?.requestedHost;
    const matchHostOnly = hostOnly || (!!input.host && !remote?.path);
    const selectLogin = (logins: ReturnType<typeof parseForgejoLogins>) =>
      remote
        ? matchForgejoLogin(logins, remote, remote.ssh ? requestedHost : undefined, matchHostOnly)
        : (logins.find((item) => item.default === "true") ??
          (new Set(logins.map((item) => item.name)).size === 1 ? logins[0] : undefined));
    let login = selectLogin(fjLogins);
    let command: "fj" | "tea" = "fj";
    if (
      !login &&
      fjLogins.some(
        (item) =>
          !remote ||
          matchForgejoLogin([item], remote, remote.ssh ? requestedHost : undefined, matchHostOnly),
      )
    ) {
      const available = yield* execute({ command: "fj", cwd: input.cwd, args: ["version"] }).pipe(
        Effect.result,
      );
      if (Result.isSuccess(available))
        return yield* new ForgejoCliError({
          command: "fj",
          cwd: input.cwd,
          reason: "authentication",
          detail: "Multiple fj logins match this repository. Specify its full server URL.",
        });
      if (available.failure.reason !== "missing-cli") return yield* available.failure;
    }
    if (login) {
      const auth = yield* authenticateFj(input.cwd, login).pipe(Effect.result);
      if (Result.isFailure(auth)) {
        if (auth.failure.reason === "missing-cli") login = undefined;
        else return yield* auth.failure;
      }
    }
    if (!login) {
      command = "tea";
      login = selectLogin(yield* listLogins({ cwd: input.cwd, command: "tea" }));
    }
    if (!login)
      return yield* new ForgejoCliError({
        command: "tea",
        cwd: input.cwd,
        reason: "authentication",
        detail:
          "No matching Forgejo login. Use `fj auth login`, `fj auth add-token`, or `tea login add` for this server; choose a default when multiple tea accounts match.",
      });
    if (hostOnly)
      return { command, login: login.name, repository: "", baseUrl: login.url.replace(/\/+$/, "") };
    const path =
      referenceRemote?.path ??
      (input.repository && !parseForgejoRemote(input.repository)
        ? input.repository
        : remote?.path) ??
      "";
    const basePath = new URL(login.url).pathname.replace(/^\/+|\/+$/g, "");
    const relativePath =
      basePath && path.split("/").length > 2 && path.startsWith(`${basePath}/`)
        ? path.slice(basePath.length + 1)
        : path;
    const repositoryPath = relativePath.replace(/\/pulls\/\d+.*$/, "").replace(/\.git$/, "");
    if (command === "fj" && !repositoryPath.includes("/")) {
      login = { ...login, user: yield* getAccount({ cwd: input.cwd, baseUrl: login.url }) };
    }
    const repository = repositoryPath.includes("/")
      ? repositoryPath
      : `${login.user}/${repositoryPath}`;
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
      return yield* new ForgejoCliError({
        command,
        cwd: input.cwd,
        detail: "Specify a Forgejo repository as owner/repository or its full server URL.",
      });
    return { command, login: login.name, repository, baseUrl: login.url.replace(/\/+$/, "") };
  });
  const resolveRepository = (input: ForgejoRepositoryInput) => resolveTarget(input);
  const api = Effect.fn("ForgejoCli.api")(function* (input: ForgejoApiInput) {
    const repository = yield* resolveTarget(
      input,
      input.path.replace(/^\/+/, "") === "user" && (!input.method || input.method === "GET"),
    );
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
    if (repository.command === "fj") {
      const token = (yield* readKeys(input.cwd)).hosts[repository.login]?.token;
      if (!token)
        return yield* new ForgejoCliError({
          command: "fj",
          cwd: input.cwd,
          reason: "authentication",
          detail: "fj has no credentials for this server.",
        });
      return yield* requestFj({
        cwd: input.cwd,
        baseUrl: repository.baseUrl,
        token,
        path,
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(stdin === undefined ? {} : { body: stdin }),
      });
    }
    const result = yield* execute({
      cwd: input.cwd,
      args: [
        "api",
        "--include",
        "--login",
        repository.login,
        ...(repository.repository ? ["--repo", repository.repository] : []),
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
  return ForgejoCli.of({ execute, listLogins, getAccount, resolveRepository, api });
});

export const layer = Layer.effect(ForgejoCli, make);
