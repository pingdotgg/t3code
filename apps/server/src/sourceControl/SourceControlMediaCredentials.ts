import * as NodeUtil from "node:util";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";

const GitLabConnection = Schema.Struct({
  apiBaseUrl: Schema.URLFromString.check(
    Schema.makeFilter(
      (url) =>
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.endsWith("/api/v4/"),
    ),
  ),
  token: Schema.String.check(Schema.isPattern(/^\S+$/u)),
});

const decodeGitLabConnection = Schema.decodeUnknownOption(GitLabConnection);

export class SourceControlMediaCredentials extends Context.Service<
  SourceControlMediaCredentials,
  {
    readonly gitHubToken: Effect.Effect<string | null>;
    readonly gitLabConnection: (
      origin: string,
    ) => Effect.Effect<typeof GitLabConnection.Type | null>;
  }
>()("t3/sourceControl/SourceControlMediaCredentials") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const gitlab = yield* GitLabCli.GitLabCli;
  const config = yield* ServerConfig.ServerConfig;
  const githubCache = yield* Cache.makeWith(
    () =>
      github
        .execute({
          cwd: config.stateDir,
          args: ["auth", "token", "--hostname", "github.com"],
          timeoutMs: 10_000,
        })
        .pipe(
          Effect.map((output) => output.stdout.trim() || null),
          Effect.orElseSucceed(() => null),
        ),
    {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== null ? "5 minutes" : 0),
    },
  );
  const gitlabCache = yield* Cache.makeWith(
    Effect.fn("SourceControlMediaCredentials.readGitLab")(
      function* (origin: string) {
        // Ask for the login host, not its possibly separate API hostname/port.
        // auth status obtains the effective token from config, keyring or environment.
        const output = yield* gitlab.execute({
          cwd: config.stateDir,
          args: ["auth", "status", "--hostname", new URL(origin).host, "--show-token"],
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1024,
        });
        const text = NodeUtil.stripVTControlCharacters(`${output.stdout}\n${output.stderr}`);
        return Option.getOrNull(
          decodeGitLabConnection({
            apiBaseUrl: /REST API Endpoint:\s*(\S+)/u.exec(text)?.[1],
            token: /Token found in [^\r\n]*?:\s*(\S+)/u.exec(text)?.[1],
          }),
        );
      },
      // CLI failures can carry credential output. They must never be logged or returned to clients.
      Effect.orElseSucceed(() => null),
    ),
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== null ? "5 minutes" : 0),
    },
  );
  return SourceControlMediaCredentials.of({
    gitHubToken: Cache.get(githubCache, "github.com"),
    gitLabConnection: (origin) => Cache.get(gitlabCache, origin),
  });
});

export const layer = Layer.effect(SourceControlMediaCredentials, make);
