/**
 * `t3.browser/profiles@1.1.0` — browser profiles and their privileged
 * maintenance (list/open, clear cookies, clear cache, cookie import), and the
 * `changes` stream of the list the desktop publishes.
 *
 * Profiles are partitions the desktop app owns, so every method is executed
 * by the environment's authenticated desktop engine host
 * (`BrowserEngineHosts.dispatchProfile`); this adapter owns the authority
 * checks and the closed projection of the host's answers. Each method sits
 * behind its own grant, enforced per call by the broker from the catalogue.
 * Without a host every method fails by name (desktop-required), and a clear
 * or import always names one profile: the desktop's all-partitions clear is
 * not reachable from here.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  BrowserImportSourceId,
  BrowserProfileId,
  PreviewViewportSetting,
  ThreadId,
  TrimmedNonEmptyString,
  type BrowserEngineProfileCommand,
  type ExtensionOperationError,
} from "@t3tools/contracts";
import {
  BROWSER_SESSION_LIMIT,
  browserProfilesApi,
  type BrowserImportCookiesResult,
  type BrowserImportFailureReason,
  type BrowserProfileChange,
  type BrowserProfileClearResult,
  type BrowserProfileList,
  type BrowserSessionReceipt,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import * as BrowserEngineHosts from "../../preview/BrowserEngineHosts.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { makeExtensionScopeResolver } from "../scope.ts";
import { failure, named, operationError, projectSession } from "./v1.ts";
import type { BrowserFaviconAssets } from "./faviconAssets.ts";

const OPERATION = "browser.profiles";
/** Room after the host's import wait for the post-checks, inside the broker deadline. */
const IMPORT_SETTLE_MS = 30_000;
const WRITE_METHODS = new Set(["open", "clearCookies", "clearCache", "importCookies"]);

const closedDecoder = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.decodeUnknownEffect(Schema.Struct(fields), { onExcessProperty: "error" });
const decodeEmpty = closedDecoder({});
const decodeOpenInput = closedDecoder({
  profileId: BrowserProfileId,
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  viewport: Schema.optional(PreviewViewportSetting),
});
const decodeTarget = closedDecoder({ profileId: BrowserProfileId });
const decodeImportInput = closedDecoder({
  profileId: BrowserProfileId,
  sourceId: BrowserImportSourceId,
  sourceProfile: TrimmedNonEmptyString.check(Schema.isMaxLength(16)),
});

/**
 * Import only ever targets an existing profile, so the desktop's two
 * new-profile bookkeeping failures cannot honestly occur; anything else
 * outside the public set reads as a failed read.
 */
const publicImportFailure = (reason: string): BrowserImportFailureReason => {
  switch (reason) {
    case "notInstalled":
    case "needsKeychainApproval":
    case "keychainItemMissing":
    case "needsFullDiskAccess":
    case "browserRunning":
    case "unsupportedPlatform":
    case "keychainUnavailable":
    case "unknownSource":
    case "unknownSourceProfile":
    case "sessionUnavailable":
    case "readFailed":
      return reason;
    default:
      return "readFailed";
  }
};

/** A host's list as the API returns it: ids and names only. */
const projectList = (list: BrowserEngineHosts.BrowserEngineProfileList) =>
  ({
    profiles: list.profiles.map((profile) => ({ id: profile.id, name: profile.name })),
    defaultProfileId: list.defaultProfileId,
  }) satisfies BrowserProfileList;

export function createBrowserProfilesApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly preview: Pick<PreviewManager.PreviewManager["Service"], "open" | "listDetails">;
    readonly engineHosts: Pick<
      BrowserEngineHosts.BrowserEngineHosts["Service"],
      "dispatchProfile" | "currentProfiles" | "profileChanges"
    >;
    /** The host's import wait (`BrowserEngineHosts.ImportAckTimeoutMs`). */
    readonly importAckTimeoutMs: number;
    /** Shared with the sessions provider so projected favicon refs resolve there. */
    readonly favicons: BrowserFaviconAssets;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const favicons = dependencies.favicons;
  /** Same shape as the sessions provider's projector: capture scoped to one project. */
  const captureFor = (projectId: string | undefined) => (dataUrl: string) =>
    projectId === undefined ? null : favicons.capture(projectId, dataUrl);

  const authorized = (principal: HostApiPrincipal | undefined, write: boolean) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(AuthOrchestrationReadScope) &&
    (!write || principal.scopes.includes(AuthOrchestrationOperateScope));

  const invoke = (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
  ): Effect.Effect<Json, ExtensionOperationError> =>
    Effect.gen(function* () {
      signal.throwIfAborted();
      const operation = `${OPERATION}.${method}`;
      if (!authorized(metadata.principal, WRITE_METHODS.has(method)) || !metadata.assertAuthority) {
        return yield* failure(operation, "Browser profiles authority is unavailable.");
      }
      const assertAuthority = metadata.assertAuthority;
      const scope = yield* resolve(context);

      const revoked = () => failure(operation, "Browser profiles authority was revoked.");
      /** Authority and scope are rechecked after the host answered, before any data returns. */
      const postChecks = Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => assertAuthority(), catch: revoked });
        yield* resolve(scope.context);
        signal.throwIfAborted();
      });

      const decode = <A, E>(decoder: (value: unknown) => Effect.Effect<A, E>) =>
        decoder(input).pipe(
          Effect.mapError(() =>
            named(
              operation,
              "BrowserProfileInputError",
              `${method} input fails the declared schema.`,
            ),
          ),
        );

      /**
       * One host round trip. Refusals every method shares fail by name here;
       * the caller projects the answers that belong to it.
       */
      const host = Effect.fn("BrowserProfiles.host")(function* (
        command: BrowserEngineProfileCommand,
        options?: Parameters<typeof dependencies.engineHosts.dispatchProfile>[1],
      ) {
        const answer = yield* dependencies.engineHosts.dispatchProfile(command, options);
        if (answer.outcome === "no-host") {
          return yield* named(
            operation,
            "BrowserProfilesUnsupported",
            `'${method}' requires the T3 Code desktop app's browser engine; none is connected to this environment (desktop-required).`,
          );
        }
        if (answer.outcome === "rejected") {
          switch (answer.reason) {
            case "unknown-profile":
              return yield* named(
                operation,
                "BrowserProfileNotFound",
                "the desktop has no browser profile with that id.",
              );
            case "not-applicable":
              return yield* named(
                operation,
                "BrowserProfilesUnsupported",
                `the desktop browser engine does not support '${method}' (engine-unsupported).`,
              );
            case "cancelled":
              return yield* revoked();
            default:
              return yield* named(
                operation,
                "BrowserProfileOperationFailed",
                `the desktop browser engine failed '${method}' (${answer.reason}).`,
              );
          }
        }
        return answer;
      });

      const unexpected = () =>
        named(
          operation,
          "BrowserProfileOperationFailed",
          `the desktop answered '${method}' with an unexpected result.`,
        );

      /**
       * The list `changes` streams, so a read and the stream never disagree;
       * a host is asked only before any has published.
       */
      const listProfiles = Effect.fn("BrowserProfiles.listProfiles")(function* () {
        const published = yield* dependencies.engineHosts.currentProfiles;
        if (published !== null) return projectList(published);
        const answer = yield* host({ _tag: "listProfiles" });
        if (answer.outcome === "unknown") {
          return yield* named(
            operation,
            "BrowserProfilesUnavailable",
            "the desktop did not answer the profile list in time (unknown).",
          );
        }
        if (answer.outcome !== "profiles") return yield* unexpected();
        return projectList(answer);
      });

      const clear = Effect.fn("BrowserProfiles.clear")(function* (
        tag: "clearCookies" | "clearCache",
      ) {
        const { profileId } = yield* decode(decodeTarget);
        const answer = yield* host({ _tag: tag, profileId });
        if (answer.outcome !== "applied" && answer.outcome !== "unknown") {
          return yield* unexpected();
        }
        yield* postChecks;
        return {
          outcome: answer.outcome === "applied" ? "cleared" : "unknown",
          profileId,
        } satisfies BrowserProfileClearResult;
      });

      switch (method) {
        case "list": {
          yield* decode(decodeEmpty);
          const list = yield* listProfiles();
          yield* postChecks;
          return list;
        }
        case "open": {
          const safe = yield* decode(decodeOpenInput);
          const threadIdRaw = scope.context.resource.threadId;
          if (!threadIdRaw) {
            return yield* failure(
              operation,
              "Opening a browser session requires a thread-scoped context.",
            );
          }
          const threadId = ThreadId.make(threadIdRaw);
          // The host is the only authority on which profiles exist; an
          // unknown id would otherwise mint an orphan partition at attach.
          const { profiles } = yield* listProfiles();
          if (!profiles.some((profile) => profile.id === safe.profileId)) {
            return yield* named(
              operation,
              "BrowserProfileNotFound",
              "the desktop has no browser profile with that id.",
            );
          }
          const listDetails = () =>
            dependencies.preview
              .listDetails({ threadId })
              .pipe(Effect.mapError(operationError(operation)));
          const before = yield* listDetails();
          if (before.sessions.length >= BROWSER_SESSION_LIMIT) {
            return yield* named(
              operation,
              "BrowserSessionLimitExceeded",
              `thread already holds ${BROWSER_SESSION_LIMIT} sessions.`,
            );
          }
          const snapshot = yield* dependencies.preview
            .open(
              {
                threadId,
                profileId: safe.profileId,
                ...(safe.url === undefined ? {} : { url: safe.url }),
                ...(safe.viewport === undefined ? {} : { viewport: safe.viewport }),
              },
              // Ownership comes from the broker's caller identity, never input.
              { extensionInstallationId: metadata.callerId },
            )
            .pipe(Effect.mapError(operationError(operation)));
          yield* postChecks;
          const after = yield* listDetails();
          const detail = after.sessions.find((entry) => entry.snapshot.tabId === snapshot.tabId);
          if (!detail) {
            return yield* failure(
              operation,
              "Opened session is not present in the post-open read.",
            );
          }
          return {
            commandId: NodeCrypto.randomUUID(),
            outcome: "accepted",
            serverEpoch: after.serverEpoch,
            revision: after.revision,
            session: projectSession(detail, captureFor(scope.context.resource.projectId)),
          } satisfies BrowserSessionReceipt;
        }
        case "clearCookies":
        case "clearCache":
          return yield* clear(method);
        case "listImportSources": {
          yield* decode(decodeEmpty);
          const answer = yield* host({ _tag: "listImportSources" });
          if (answer.outcome === "unknown") {
            return yield* named(
              operation,
              "BrowserProfilesUnavailable",
              "the desktop did not answer the import source list in time (unknown).",
            );
          }
          if (answer.outcome !== "import-sources") return yield* unexpected();
          yield* postChecks;
          return {
            sources: answer.sources.map((source) => ({
              id: source.id,
              name: source.name,
              ...(source.unavailable === undefined ? {} : { unavailable: source.unavailable }),
              profiles: source.profiles.map((profile) => ({
                handle: profile.handle,
                name: profile.name,
                ...(profile.cookieCount === undefined ? {} : { cookieCount: profile.cookieCount }),
              })),
            })),
          };
        }
        case "importCookies": {
          const safe = yield* decode(decodeImportInput);
          // The user may sit on the prompt for minutes; authority is proven
          // again after they confirm and before the host reads the source.
          const stillAuthorized = postChecks.pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          );
          const answer = yield* host(
            {
              _tag: "importCookies",
              profileId: safe.profileId,
              sourceId: safe.sourceId,
              sourceProfile: safe.sourceProfile,
              requester: metadata.rootCallerId.slice(0, 128) || "an extension",
            },
            { beforeProceed: stillAuthorized },
          );
          let result: BrowserImportCookiesResult;
          switch (answer.outcome) {
            case "imported":
              result = {
                outcome: "imported",
                profileId: safe.profileId,
                imported: answer.imported,
                skipped: answer.skipped,
              };
              break;
            case "declined":
            case "unknown":
              result = { outcome: answer.outcome, profileId: safe.profileId };
              break;
            case "import-failed":
              result = {
                outcome: "failed",
                profileId: safe.profileId,
                reason: publicImportFailure(answer.reason),
              };
              break;
            default:
              return yield* unexpected();
          }
          yield* postChecks;
          return result;
        }
        default:
          return yield* failure(operation, "Browser profiles method is unavailable.");
      }
    });

  /**
   * `changes`: the environment's current state, then each different one —
   * `{ list: null }` while no desktop is connected, so a web-only client
   * learns that at once and hears when a desktop arrives or the last one
   * leaves; `{ list: null, pending: true }` while a connected desktop has
   * not published yet, so a view shows loading rather than "no desktop" or
   * an old list. Never a value equal to the last one sent.
   */
  const subscribe = (
    name: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: HostApiInvocationMetadata,
    resumeCursor?: string,
  ): AsyncIterable<ApiStreamEvent> => {
    const operation = `${OPERATION}.changes`;
    if (name !== "changes") throw failure(operation, "Browser profiles stream is unavailable.");
    if (resumeCursor !== undefined) {
      throw failure(operation, "Browser profiles stream does not support resume cursors.");
    }
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length > 0
    ) {
      throw named(
        operation,
        "BrowserProfileInputError",
        "changes input fails the declared schema.",
      );
    }
    const assertAuthority = metadata.assertAuthority;
    if (!authorized(metadata.principal, false) || !assertAuthority) {
      throw failure(operation, "Browser profiles authority is unavailable.");
    }
    const revoked = () => failure(operation, "Browser profiles authority was revoked.");
    const aborted = Effect.callback<void>((resume) => {
      if (signal.aborted) return resume(Effect.void);
      signal.addEventListener("abort", () => resume(Effect.void), { once: true });
    });
    const events = Stream.unwrap(
      Effect.map(resolve(context), (scope) =>
        dependencies.engineHosts.profileChanges.pipe(
          // A host that reconnects republishes; an equal list is not news.
          Stream.changesWith((a, b) =>
            a === "pending" || b === "pending" ? a === b : BrowserEngineHosts.sameProfileList(a, b),
          ),
          // Authority and scope are rechecked before each state is delivered.
          Stream.mapEffect((state) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({ try: () => assertAuthority(), catch: revoked });
              yield* resolve(scope.context);
              return state;
            }),
          ),
          Stream.map((state, index): ApiStreamEvent => ({
            type: index === 0 ? "snapshot" : "data",
            value: (state === "pending"
              ? { list: null, pending: true }
              : {
                  list: state === null ? null : projectList(state),
                }) satisfies BrowserProfileChange,
          })),
        ),
      ),
    ).pipe(Stream.interruptWhen(aborted));
    return Stream.toAsyncIterable(events);
  };

  return {
    providerId: "t3.host-browser-profiles",
    definition: browserProfilesApi.definition,
    requiresRootAuthority: true,
    subscribe,
    // Import waits on a confirmation and possibly a keychain prompt; the
    // broker's default deadline would cut the user off mid-decision.
    deadlineMs: (method) =>
      method === "importCookies" ? dependencies.importAckTimeoutMs + IMPORT_SETTLE_MS : undefined,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(invoke(method, input, context, signal, metadata), { signal }),
  };
}

export const makeBrowserProfilesApiProvider = Effect.fn("BrowserProfilesApi.make")(
  function* (input: { readonly favicons: BrowserFaviconAssets }) {
    const environment = yield* ServerEnvironment;
    return createBrowserProfilesApiProvider({
      environmentId: yield* environment.getEnvironmentId,
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
      preview: yield* PreviewManager.PreviewManager,
      engineHosts: yield* BrowserEngineHosts.BrowserEngineHosts,
      importAckTimeoutMs: yield* BrowserEngineHosts.ImportAckTimeoutMs,
      favicons: input.favicons,
    });
  },
);
