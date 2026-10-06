import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";
import * as PhabricatorPullRequestProvider from "../pullRequest/PhabricatorPullRequestProvider.ts";
import type { ProviderChangeRequestSummary } from "../pullRequest/PullRequestProvider.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import { SourceControlProvider } from "./SourceControlProvider.ts";
import {
  providerAuth,
  type SourceControlManagedCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import { makeConfiguredOrigin } from "./phabricatorConfig.ts";

export const makeDiscovery = Effect.gen(function* () {
  const process = yield* VcsProcess;
  const configuredOrigin = yield* makeConfiguredOrigin;
  const provider = yield* PhabricatorPullRequestProvider.make;
  return {
    type: "managed-cli",
    kind: "phabricator",
    label: "Phabricator",
    installHint:
      "Install Arcanist and run `arc install-certificate` on the T3 Code server. Configure phabricator.uri in the project's .arcconfig.",
    probe: Effect.fn("PhabricatorSourceControlProvider.probe")(function* (cwd: string) {
      const version = yield* process
        .run({
          cwd,
          command: "arc",
          args: ["version"],
          operation: "phabricator.discovery",
          timeoutMs: 5_000,
        })
        .pipe(Effect.option);
      const origin = yield* configuredOrigin(cwd);
      const viewer = Option.isSome(version)
        ? yield* provider
            .getViewer({ cwd, ...(origin ? { host: new URL(origin).host } : {}) })
            .pipe(Effect.option)
        : Option.none<string>();
      return {
        kind: "phabricator" as const,
        label: "Phabricator",
        executable: "arc",
        status: Option.isSome(version) ? ("available" as const) : ("missing" as const),
        version: Option.isSome(version)
          ? Option.fromNullishOr(version.value.stdout.trim().split("\n")[0])
          : Option.none(),
        installHint: "Install Arcanist and run `arc install-certificate` on the T3 Code server.",
        detail: Option.none(),
        auth: providerAuth({
          status: Option.isNone(version)
            ? "unknown"
            : Option.isSome(viewer)
              ? "authenticated"
              : "unauthenticated",
          ...(Option.isSome(viewer) ? { account: viewer.value } : {}),
          ...(origin ? { host: new URL(origin).host } : {}),
        }),
      };
    }),
    refineUnknownRemote: Effect.fn("PhabricatorSourceControlProvider.refineUnknownRemote")(
      function* (
        input: Parameters<SourceControlManagedCliDiscoverySpec["refineUnknownRemote"]>[0],
      ) {
        const origin = yield* configuredOrigin(input.cwd);
        if (!origin) return null;
        // Project routing currently requires the review server and remote to share a hostname.
        const remote = detectSourceControlProviderFromRemoteUrl(input.context.remoteUrl);
        if (!remote || new URL(origin).hostname !== new URL(remote.baseUrl).hostname) return null;
        return { kind: "phabricator" as const, name: "Phabricator", baseUrl: origin };
      },
    ),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

export const make = Effect.gen(function* () {
  const provider = yield* PhabricatorPullRequestProvider.make;
  const process = yield* VcsProcess;
  const failure = (operation: string, cwd: string, detail: string) =>
    new SourceControlProviderError({ provider: "phabricator", operation, cwd, detail });
  const unsupported = (operation: string, cwd: string) =>
    Effect.fail(
      failure(
        operation,
        cwd,
        "This operation is not supported for Phabricator. Use Arcanist to create revisions.",
      ),
    );
  const ref = (input: { cwd: string; context?: { provider: { baseUrl: string } } }) => ({
    cwd: input.cwd,
    host: input.context ? new URL(input.context.provider.baseUrl).host : "",
    repository: "differential",
  });
  const normalize = (revision: ProviderChangeRequestSummary): ChangeRequest => ({
    provider: "phabricator",
    number: revision.number,
    title: revision.title,
    url: revision.url,
    headRefName: revision.headBranch,
    baseRefName: revision.baseBranch,
    state: revision.state,
    isDraft: revision.isDraft ?? false,
    updatedAt: DateTime.make(revision.updatedAt),
  });
  const get = Effect.fn("PhabricatorSourceControlProvider.get")(function* (
    input: Parameters<SourceControlProvider["Service"]["getChangeRequest"]>[0],
  ) {
    const target = parseChangeRequestUrl(input.reference);
    const number =
      target?.repository === "differential"
        ? target.number
        : Number(/^D?([1-9]\d*)$/u.exec(input.reference)?.[1]);
    if (target && input.context && (target.authority ?? target.host) !== ref(input).host) {
      return yield* failure(
        "getChangeRequest",
        input.cwd,
        "This revision belongs to a different review server.",
      );
    }
    if (!Number.isSafeInteger(number) || number < 1)
      return yield* failure(
        "getChangeRequest",
        input.cwd,
        "Specify D123 or a Differential revision URL.",
      );
    return yield* (provider.getChangeRequestSummary ?? provider.getChangeRequest)({
      ...ref(input),
      number,
    }).pipe(
      Effect.map(normalize),
      Effect.mapError((error) => failure("getChangeRequest", input.cwd, error.detail)),
    );
  });
  return SourceControlProvider.of({
    kind: "phabricator",
    getChangeRequest: get,
    // Differential has no reliable branch query. Explicit links still get live status tracking.
    listChangeRequests: () => Effect.succeed([]),
    createChangeRequest: (input) => unsupported("createChangeRequest", input.cwd),
    createRepository: (input) => unsupported("createRepository", input.cwd),
    getRepositoryCloneUrls: (input) => unsupported("getRepositoryCloneUrls", input.cwd),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: Effect.fn("PhabricatorSourceControlProvider.checkout")(
      function* (input) {
        const revision = yield* get(input);
        yield* process
          .run({
            cwd: input.cwd,
            command: "arc",
            args: ["patch", `D${revision.number}`],
            operation: "phabricator.checkout",
          })
          .pipe(
            Effect.mapError(() =>
              failure(
                "checkoutChangeRequest",
                input.cwd,
                "Arcanist could not apply this revision. Check the working tree and authentication.",
              ),
            ),
          );
      },
    ),
  });
});
