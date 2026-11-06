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

  const glab = (args: ReadonlyArray<string>) =>
    process
      .run({
        operation: "GitLabCredentials.get",
        command: "glab",
        args,
        cwd: workingDirectory,
        env: STORED_ONLY_ENV,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(Effect.map((output) => output.stdout.trim()));

  const storedToken = (host: string) => glab(["config", "get", "token", "--host", host]);

  const lookup = Effect.fn("GitLabCredentials.lookup")(function* (host: string) {
    if ((yield* storedToken(host)) === "") return Option.none();
    // An OAuth login expires within hours and glab refreshes it only on an API call.
    if ((yield* glab(["config", "get", "is_oauth2", "--host", host])) === "true") {
      yield* glab(["api", "--hostname", host, "user"]).pipe(Effect.ignore);
    }
    const token = yield* storedToken(host);
    return token === "" ? Option.none() : Option.some(Redacted.make(token));
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
