import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import { parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";

/** How long a token is reused before `glab` is asked again. */
const TOKEN_TTL = Duration.minutes(5);
/** A missing login is asked again soon, so a fresh `glab auth login` applies. */
const MISSING_TTL = Duration.seconds(10);

/**
 * glab hands an environment token to whichever host it is asked about. The host here comes from a
 * URL someone wrote into a merge request, so only the token stored for that host may answer.
 */
const STORED_ONLY_ENV = {
  GITLAB_TOKEN: "",
  GITLAB_ACCESS_TOKEN: "",
  OAUTH_TOKEN: "",
  CI_JOB_TOKEN: "",
  GLAB_ENABLE_CI_AUTOLOGIN: "false",
};

/** The token `glab` stores for a GitLab host, used to read what that host serves to the user. */
export class GitLabCredentials extends Context.Service<
  GitLabCredentials,
  {
    /** None when `glab` holds no login for the host. */
    readonly get: (host: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    /** Drops the held token after GitLab refused it, so the next read asks `glab` again. */
    readonly invalidate: (host: string) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-gitlab/server/GitLabCredentials") {}

/** @public */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const run = (args: ReadonlyArray<string>, timeoutMs = 10_000) =>
    process.run({
      operation: "GitLabCredentials.get",
      command: "glab",
      args,
      cwd: workingDirectory,
      env: STORED_ONLY_ENV,
      allowNonZeroExit: true,
      timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
  const glab = (args: ReadonlyArray<string>) =>
    run(args).pipe(Effect.map((output) => output.stdout.trim()));

  const storedToken = (host: string) => glab(["config", "get", "token", "--host", host]);

  /** The login whose `api_host` is `host`, as a login stored under an SSH alias has. */
  const aliasFor = Effect.fn("GitLabCredentials.aliasFor")(function* (host: string) {
    // glab 1.79+ lists every host only with `--all`; older glab rejects the flag.
    for (const args of [
      ["auth", "status", "--all"],
      ["auth", "status"],
    ]) {
      const output = yield* run(args, 30_000);
      const hosts = parseGitLabAuthStatusHosts(`${output.stdout}\n${output.stderr}`);
      if (hosts.length > 0) return hosts.find((entry) => entry.apiHost === host)?.host;
    }
    return undefined;
  });

  const login = Effect.fn("GitLabCredentials.login")(function* (host: string) {
    if ((yield* storedToken(host)) === "") return Option.none();
    // An OAuth login expires within hours and glab refreshes it only on an API call.
    if ((yield* glab(["config", "get", "is_oauth2", "--host", host])) === "true") {
      yield* glab(["api", "--hostname", host, "user"]).pipe(Effect.ignore);
    }
    const token = yield* storedToken(host);
    return token === "" ? Option.none() : Option.some(Redacted.make(token));
  });

  const lookup = Effect.fn("GitLabCredentials.lookup")(function* (host: string) {
    const token = yield* login(host);
    if (Option.isSome(token)) return token;
    const alias = yield* aliasFor(host);
    return alias === undefined || alias === host ? Option.none() : yield* login(alias);
  });

  const cache = yield* Cache.makeWith(
    (host: string) => lookup(host).pipe(Effect.orElseSucceed(() => Option.none())),
    {
      capacity: 32,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value) ? TOKEN_TTL : MISSING_TTL,
    },
  );

  return GitLabCredentials.of({
    get: Effect.fn("GitLabCredentials.get")((host) => Cache.get(cache, host.trim().toLowerCase())),
    invalidate: Effect.fn("GitLabCredentials.invalidate")((host) =>
      Cache.invalidate(cache, host.trim().toLowerCase()),
    ),
  });
});

export const layer = Layer.effect(GitLabCredentials, make);
