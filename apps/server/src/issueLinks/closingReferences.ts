import type { IssueKey } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";

/** A pull request, as the host-level key closing references are read for. */
export interface PullRequestKey {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * The Issues a pull request closes (`Closes #N`), read from GitHub when a thread's links are read
 * rather than stored. The other direction needs no read: the Issues list already has each Issue's
 * closing pull requests and passes them in.
 */
export class IssueClosingReferences extends Context.Service<
  IssueClosingReferences,
  {
    /**
     * Issues the pull request closes. `version` is the pull request's last known update time:
     * a changed version rereads, an unchanged one is served from memory.
     */
    readonly issuesClosedBy: (input: {
      readonly pullRequest: PullRequestKey;
      readonly version: string | null;
      readonly cwd: string;
    }) => Effect.Effect<ReadonlyArray<IssueKey>>;
  }
>()("t3/issueLinks/closingReferences/IssueClosingReferences") {}

const ReferenceNodes = Schema.Struct({
  nodes: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Int,
        repository: Schema.Struct({ nameWithOwner: Schema.String }),
      }),
    ),
  ),
});

const decodePullRequestResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(Schema.Struct({ closingIssuesReferences: ReferenceNodes })),
          }),
        ),
      }),
    }),
  ),
);

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } }
    }
  }
}`;

function keysOf(
  host: string,
  references: typeof ReferenceNodes.Type | undefined,
): ReadonlyArray<IssueKey> {
  return (references?.nodes ?? []).flatMap((node) =>
    node === null || node.number < 1
      ? []
      : [{ host, repository: node.repository.nameWithOwner.toLowerCase(), number: node.number }],
  );
}

/** Freshness for a version-keyed read; an unversioned one can go stale unnoticed, so briefly. */
const UNVERSIONED_TTL = Duration.minutes(1);
const VERSIONED_TTL = Duration.minutes(30);

const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;

  const query = (input: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
    readonly cwd: string;
    readonly document: string;
  }) => {
    const [owner, name] = input.repository.split("/");
    return github
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "--hostname",
          input.host,
          "-f",
          `query=${input.document}`,
          "-f",
          `owner=${owner ?? ""}`,
          "-f",
          `name=${name ?? ""}`,
          "-F",
          `number=${input.number}`,
        ],
        rateLimitHost: input.host,
      })
      .pipe(Effect.map((output) => output.stdout));
  };

  // Keys are JSON so the cache compares them by value.
  const pullRequestCache = yield* Cache.makeWith(
    (key: string) => {
      const input = JSON.parse(key) as PullRequestKey & { cwd: string };
      return query({ ...input, document: PULL_REQUEST_QUERY }).pipe(
        Effect.map((raw) =>
          decodePullRequestResponse(raw).pipe(
            Option.map((response) =>
              keysOf(
                input.host,
                response.data.repository?.pullRequest?.closingIssuesReferences ?? undefined,
              ),
            ),
            Option.getOrElse((): ReadonlyArray<IssueKey> => []),
          ),
        ),
      );
    },
    {
      capacity: 512,
      timeToLive: (exit, key) =>
        Exit.isFailure(exit)
          ? Duration.zero
          : (JSON.parse(key) as { version: string | null }).version === null
            ? UNVERSIONED_TTL
            : VERSIONED_TTL,
    },
  );

  // A failed read (no gh, signed out, rate limited) leaves the derived links out rather than
  // failing the whole read: stored and branch links still show.
  const orNone = <A>(effect: Effect.Effect<ReadonlyArray<A>, GitHubCli.GitHubCliError>) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logDebug("Could not read GitHub closing references", error).pipe(
          Effect.as<ReadonlyArray<A>>([]),
        ),
      ),
    );

  return IssueClosingReferences.of({
    issuesClosedBy: ({ pullRequest, version, cwd }) =>
      orNone(
        Cache.get(
          pullRequestCache,
          JSON.stringify({
            host: pullRequest.host.toLowerCase(),
            repository: pullRequest.repository.toLowerCase(),
            number: pullRequest.number,
            version,
            cwd,
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(IssueClosingReferences, make);
