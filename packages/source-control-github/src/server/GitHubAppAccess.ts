import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const Installations = Schema.fromJsonString(
  Schema.Struct({
    installations: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        repository_selection: Schema.String,
        account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
      }),
    ),
  }),
);

const InstallationRepositories = Schema.fromJsonString(
  Schema.Struct({ repositories: Schema.Array(Schema.Struct({ full_name: Schema.String })) }),
);

const Viewer = Schema.fromJsonString(Schema.Struct({ login: Schema.String }));

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// Installing the app on another account should show up soon after the user comes back.
const COVERAGE_TTL = Duration.minutes(2);
// A failed read answers `covered`; keep that briefly so an outage is not re-asked per request.
const COVERAGE_FAILURE_TTL = Duration.seconds(30);

/** Whether the app sign-in reaches a repository; `signed-out` when the server is not signed in. */
export type GitHubAppReach = "covered" | "not-covered" | "signed-out";

/** Accounts that installed the app for all repositories, and repositories listed one by one. */
interface AppCoverage {
  readonly accounts: ReadonlySet<string>;
  readonly repositories: ReadonlySet<string>;
}

export class GitHubAppAccess extends Context.Service<
  GitHubAppAccess,
  {
    /**
     * Whether an installation covers `owner/name`. A check that fails answers `covered`, so a
     * GitHub hiccup does not nag the user.
     */
    readonly reach: (host: string, repository: string) => Effect.Effect<GitHubAppReach>;
    /** The login the app sign-in acts as. */
    readonly viewer: (host: string) => Effect.Effect<string, GitHubRequestPolicy.GitHubApiError>;
    /**
     * The credential for work pinned to one repository: the app's only where an installation is
     * confirmed to cover it, the user's own otherwise when there is one.
     */
    readonly credentialFor: (
      host: string,
      repository: string,
    ) => Effect.Effect<
      GitHubRequestPolicy.GitHubHeldCredential,
      GitHubRequestPolicy.GitHubApiError
    >;
  }
>()("@t3tools/source-control-github/server/GitHubAppAccess") {}

/** Callers may name a repository as a URL, `host/owner/name` or `owner/name.git`. */
function ownerAndName(repository: string): string {
  return repository
    .trim()
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .split(/[/:]/)
    .filter((segment) => segment.length > 0)
    .slice(-2)
    .join("/");
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;

  /** Reads `path` as the app sign-in, whatever credential outranks it elsewhere. */
  const readAsApp = Effect.fn("GitHubAppAccess.readAsApp")(function* <A>(
    host: string,
    operation: string,
    path: string,
    schema: Schema.Codec<A, string>,
  ) {
    const app = yield* api.appCredential(host);
    if (Option.isNone(app)) return Option.none<A>();
    const response = yield* api.rest({ host, operation, path, allowReserve: true }).pipe(
      Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
        host,
        token: app.value.token,
        credentialFingerprint: app.value.fingerprint,
      }),
    );
    return Option.some(yield* Schema.decodeEffect(schema)(response.body));
  });

  const coverageOf = Effect.fn("GitHubAppAccess.coverageOf")(function* (host: string) {
    const installations: Array<{
      readonly id: number;
      readonly repository_selection: string;
      readonly account: { readonly login: string } | null;
    }> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const listed = yield* readAsApp(
        host,
        "appInstallations",
        `user/installations?per_page=${PAGE_SIZE}&page=${page}`,
        Installations,
      );
      if (Option.isNone(listed)) return null;
      installations.push(...listed.value.installations);
      if (listed.value.installations.length < PAGE_SIZE) break;
    }
    const accounts = new Set<string>();
    const repositories = new Set<string>();
    for (const installation of installations) {
      const login = installation.account?.login.toLowerCase();
      if (login === undefined) continue;
      if (installation.repository_selection === "all") {
        accounts.add(login);
        continue;
      }
      for (let page = 1; ; page++) {
        // Past the cap the list is cut short; count the whole account as reached rather than nag.
        if (page > MAX_PAGES) {
          accounts.add(login);
          break;
        }
        const listed = yield* readAsApp(
          host,
          "appInstallationRepositories",
          `user/installations/${installation.id}/repositories?per_page=${PAGE_SIZE}&page=${page}`,
          InstallationRepositories,
        );
        if (Option.isNone(listed)) return null;
        for (const repository of listed.value.repositories) {
          repositories.add(repository.full_name.toLowerCase());
        }
        if (listed.value.repositories.length < PAGE_SIZE) break;
      }
    }
    return { accounts, repositories } satisfies AppCoverage;
  });

  const coverage = yield* Cache.makeWith(coverageOf, {
    capacity: 8,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? COVERAGE_TTL : COVERAGE_FAILURE_TTL),
  });

  /** `unknown` when GitHub could not list the installations just now. */
  const coverageFor = Effect.fn("GitHubAppAccess.coverageFor")(function* (
    rawHost: string,
    rawRepository: string,
  ) {
    const host = rawHost.trim().toLowerCase();
    if (!appSignIn.enabled) return "signed-out" as const;
    const known = yield* Cache.get(coverage, host).pipe(Effect.option);
    if (Option.isNone(known)) return "unknown" as const;
    if (known.value === null) return "signed-out" as const;
    const repository = ownerAndName(rawRepository);
    const owner = repository.split("/")[0] ?? "";
    return known.value.accounts.has(owner) || known.value.repositories.has(repository)
      ? ("covered" as const)
      : ("not-covered" as const);
  });

  const reach: GitHubAppAccess["Service"]["reach"] = (host, repository) =>
    coverageFor(host, repository).pipe(
      Effect.map((answer) => (answer === "unknown" ? "covered" : answer)),
    );

  const viewer: GitHubAppAccess["Service"]["viewer"] = Effect.fn("GitHubAppAccess.viewer")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      // A new sign-in can reach different installations than the cached answer.
      yield* Cache.invalidate(coverage, host);
      const login = yield* readAsApp(host, "appViewer", "user", Viewer).pipe(
        Effect.catchTags({
          SchemaError: () => Effect.succeed(Option.none<{ readonly login: string }>()),
        }),
      );
      if (Option.isNone(login)) {
        return yield* new GitHubRequestPolicy.GitHubApiAuthenticationError({
          host,
          operation: "appViewer",
        });
      }
      return login.value.login;
    },
  );

  const credentialFor: GitHubAppAccess["Service"]["credentialFor"] = Effect.fn(
    "GitHubAppAccess.credentialFor",
  )(function* (host, repository) {
    // Pinned work cannot be handed on, so only confirmed app access keeps the app credential.
    if ((yield* coverageFor(host, repository)) === "covered") return yield* api.credential(host);
    return yield* api
      .credential(host, { personal: true })
      .pipe(Effect.catch(() => api.credential(host)));
  });

  return GitHubAppAccess.of({ reach, viewer, credentialFor });
});

export const layer = Layer.effect(GitHubAppAccess, make);
