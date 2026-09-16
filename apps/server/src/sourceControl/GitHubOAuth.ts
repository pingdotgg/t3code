import {
  GitHubOAuthError,
  type GitHubAccount,
  type GitHubAccountId,
  type GitHubOAuthStartInput,
  type GitHubOAuthState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

export const GITHUB_OAUTH_FLOW_TIMEOUT = Duration.minutes(15);
export const GITHUB_OAUTH_STATE_RETENTION = Duration.minutes(5);

interface StateEntry {
  readonly state: SubscriptionRef.SubscriptionRef<GitHubOAuthState>;
  subscribers: number;
  reapRequested: boolean;
}

interface ActiveFlow {
  readonly flowId: string;
  readonly state: SubscriptionRef.SubscriptionRef<GitHubOAuthState>;
  readonly entry: StateEntry;
  /** A compare-and-set snapshot prevents a deleted account from returning. */
  readonly accountAtStart: GitHubAccount | undefined;
  fiber?: Fiber.Fiber<void, unknown>;
}

const idleState = (accountId: GitHubAccountId): GitHubOAuthState => ({
  accountId,
  phase: "idle",
  flowId: null,
  verificationUrl: null,
  userCode: null,
  account: null,
  message: null,
});

export function parseGitHubOAuthUserCode(output: string): string | null {
  return /one-time code:\s*([A-Z0-9-]+)/iu.exec(output)?.[1] ?? null;
}

export class GitHubOAuth extends Context.Service<
  GitHubOAuth,
  {
    readonly start: (
      input: GitHubOAuthStartInput,
    ) => Effect.Effect<GitHubOAuthState, GitHubOAuthError>;
    readonly cancel: (
      accountId: GitHubAccountId,
      flowId: string,
    ) => Effect.Effect<GitHubOAuthState, GitHubOAuthError>;
    readonly subscribe: (accountId: GitHubAccountId) => Stream.Stream<GitHubOAuthState>;
  }
>()("t3/sourceControl/GitHubOAuth") {}

export const make = Effect.fn("GitHubOAuth.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcessPlatform;
  const states = new Map<GitHubAccountId, StateEntry>();
  const active = new Map<GitHubAccountId, ActiveFlow>();
  const commitGate = yield* Semaphore.make(1);

  const getState = Effect.fn("GitHubOAuth.getState")(function* (accountId: GitHubAccountId) {
    const existing = states.get(accountId);
    if (existing) return existing;
    const entry: StateEntry = {
      state: yield* SubscriptionRef.make(idleState(accountId)),
      subscribers: 0,
      reapRequested: false,
    };
    states.set(accountId, entry);
    return entry;
  });

  const isTerminal = (phase: GitHubOAuthState["phase"]) =>
    phase === "succeeded" || phase === "failed" || phase === "cancelled";

  const scheduleStateReap = Effect.fn("GitHubOAuth.scheduleStateReap")(function* (
    accountId: GitHubAccountId,
    entry: StateEntry,
    flowId: string,
  ) {
    yield* Effect.sleep(GITHUB_OAUTH_STATE_RETENTION).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          if (states.get(accountId) !== entry || active.has(accountId)) return;
          const state = yield* SubscriptionRef.get(entry.state);
          if (state.flowId !== flowId || !isTerminal(state.phase)) return;
          entry.reapRequested = true;
          if (entry.subscribers === 0) states.delete(accountId);
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const fail = (accountId: GitHubAccountId, operation: string, detail: string, cause?: unknown) =>
    new GitHubOAuthError({
      accountId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const persistCredential = Effect.fn("GitHubOAuth.persistCredential")(function* (
    input: GitHubOAuthStartInput,
    flow: ActiveFlow,
    token: string,
    login: string,
  ) {
    return yield* commitGate.withPermits(1)(
      Effect.gen(function* () {
        if (active.get(input.accountId) !== flow) return null;
        const updated = yield* serverSettings
          .persistGitHubAccountTokenIfCurrent({
            accountId: input.accountId,
            expectedAccount: flow.accountAtStart,
            account: { label: input.label, login, host: input.host },
            token,
          })
          .pipe(
            Effect.mapError((cause) =>
              fail(input.accountId, "save", "Could not save the GitHub OAuth credential.", cause),
            ),
          );
        if (updated === null) {
          return yield* fail(
            input.accountId,
            "save",
            "The GitHub account was removed before sign-in completed.",
          );
        }
        if (active.get(input.accountId) !== flow) return null;
        active.delete(input.accountId);
        yield* scheduleStateReap(input.accountId, flow.entry, flow.flowId);
        yield* SubscriptionRef.set(flow.state, {
          accountId: input.accountId,
          phase: "succeeded",
          flowId: flow.flowId,
          verificationUrl: null,
          userCode: null,
          account: updated.githubAccounts[input.accountId] ?? null,
          message: `Signed in as ${login}.`,
        });
        return updated.githubAccounts[input.accountId] ?? null;
      }),
    );
  });

  const runFlow = Effect.fn("GitHubOAuth.runFlow")(function* (
    input: GitHubOAuthStartInput,
    flow: ActiveFlow,
  ) {
    const {
      GH_TOKEN: _ghToken,
      GITHUB_TOKEN: _githubToken,
      GH_ENTERPRISE_TOKEN: _ghEnterpriseToken,
      GITHUB_ENTERPRISE_TOKEN: _githubEnterpriseToken,
      ...baseEnvironment
    } = globalThis.process.env;
    const environment = {
      ...baseEnvironment,
      // Keep browser navigation on the connected client. `gh` still owns the
      // device flow and prints the one-time code that T3 forwards over RPC.
      GH_BROWSER: platform === "win32" ? "cmd /d /c exit 0" : "true",
      LANG: "C",
      LC_ALL: "C",
    };
    const command = yield* spawner
      .spawn(
        ChildProcess.make(
          "gh",
          ["auth", "login", "--hostname", input.host, "--git-protocol", "https", "--web"],
          { env: environment, extendEnv: false, shell: false },
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          fail(input.accountId, "start", "GitHub CLI (`gh`) is required to sign in.", cause),
        ),
      );
    yield* Effect.addFinalizer(() => command.kill().pipe(Effect.ignore));

    let output = "";
    const readOutput = (stream: Stream.Stream<Uint8Array, unknown>) => {
      const decoder = new TextDecoder();
      return stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            output = `${output}${decoder.decode(chunk, { stream: true })}`.slice(-16_384);
            const userCode = parseGitHubOAuthUserCode(output);
            if (!userCode || active.get(input.accountId) !== flow) return;
            const current = yield* SubscriptionRef.get(flow.state);
            if (current.phase !== "starting") return;
            yield* SubscriptionRef.set(flow.state, {
              ...current,
              phase: "waiting",
              verificationUrl: `https://${input.host}/login/device`,
              userCode,
              message: "Enter this one-time code in GitHub to finish signing in.",
            });
          }),
        ),
        Effect.mapError((cause) =>
          fail(input.accountId, "authorize", "Could not read GitHub sign-in output.", cause),
        ),
      );
    };

    const [, , exitCode] = yield* Effect.all(
      [readOutput(command.stdout), readOutput(command.stderr), command.exitCode],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) {
      return yield* fail(input.accountId, "authorize", "GitHub sign-in did not complete.");
    }
    if (active.get(input.accountId) !== flow) return;
    yield* SubscriptionRef.update(flow.state, (state): GitHubOAuthState => ({
      ...state,
      phase: "verifying",
      verificationUrl: null,
      userCode: null,
      message: "Verifying the GitHub account.",
    }));

    const identity = yield* processRunner
      .run({
        command: "gh",
        args: ["api", "--hostname", input.host, "user", "--jq", ".login"],
        env: environment,
        timeout: "30 seconds",
      })
      .pipe(
        Effect.mapError((cause) =>
          fail(input.accountId, "verify", "Could not verify the GitHub account.", cause),
        ),
      );
    const login = identity.stdout.trim();
    if (identity.code !== 0 || login.length === 0) {
      return yield* fail(input.accountId, "verify", "Could not verify the GitHub account.");
    }
    const credential = yield* processRunner
      .run({
        command: "gh",
        args: ["auth", "token", "--hostname", input.host, "--user", login],
        env: environment,
        timeout: "30 seconds",
      })
      .pipe(
        Effect.mapError((cause) =>
          fail(input.accountId, "verify", "Could not read the GitHub OAuth credential.", cause),
        ),
      );
    const token = credential.stdout.trim();
    if (credential.code !== 0 || token.length === 0) {
      return yield* fail(input.accountId, "verify", "Could not read the GitHub OAuth credential.");
    }
    if (active.get(input.accountId) !== flow) return;
    yield* persistCredential(input, flow, token, login);
  });

  const start: GitHubOAuth["Service"]["start"] = Effect.fn("GitHubOAuth.start")(function* (input) {
    const previous = active.get(input.accountId);
    if (previous?.fiber) yield* Fiber.interrupt(previous.fiber);
    const accountAtStart = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        fail(input.accountId, "start", "Could not read GitHub account settings.", cause),
      ),
      Effect.map((settings) => settings.githubAccounts[input.accountId]),
    );
    const flowId = Encoding.encodeBase64Url(
      yield* crypto
        .randomBytes(18)
        .pipe(
          Effect.mapError((cause) =>
            fail(input.accountId, "start", "Could not start GitHub sign-in.", cause),
          ),
        ),
    );
    const entry = yield* getState(input.accountId);
    entry.reapRequested = false;
    const flow: ActiveFlow = { flowId, state: entry.state, entry, accountAtStart };
    const starting: GitHubOAuthState = {
      accountId: input.accountId,
      phase: "starting",
      flowId,
      verificationUrl: null,
      userCode: null,
      account: null,
      message: "Starting GitHub sign-in.",
    };
    yield* commitGate.withPermits(1)(
      Effect.gen(function* () {
        active.set(input.accountId, flow);
        yield* SubscriptionRef.set(entry.state, starting);
      }),
    );
    const fiber = yield* runFlow(input, flow).pipe(
      Effect.timeoutOrElse({
        duration: GITHUB_OAUTH_FLOW_TIMEOUT,
        orElse: () =>
          Effect.fail(
            fail(input.accountId, "authorize", "GitHub sign-in timed out. Start sign-in again."),
          ),
      }),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (active.get(input.accountId) !== flow) return;
          active.delete(input.accountId);
          yield* scheduleStateReap(input.accountId, entry, flow.flowId);
          if (active.get(input.accountId) !== undefined) return;
          yield* SubscriptionRef.update(entry.state, (current): GitHubOAuthState => ({
            ...current,
            phase: "failed",
            verificationUrl: null,
            userCode: null,
            message: error.message,
          }));
        }),
      ),
      Effect.scoped,
      Effect.forkIn(scope),
    );
    flow.fiber = fiber;
    if (active.get(input.accountId) !== flow) yield* Fiber.interrupt(fiber);
    return starting;
  });

  const cancelActiveFlow = Effect.fn("GitHubOAuth.cancelActiveFlow")(function* (
    accountId: GitHubAccountId,
    flow: ActiveFlow,
  ) {
    const cancelled = yield* commitGate.withPermits(1)(
      Effect.gen(function* () {
        if (active.get(accountId) !== flow) return null;
        active.delete(accountId);
        const state: GitHubOAuthState = {
          ...(yield* SubscriptionRef.get(flow.state)),
          phase: "cancelled",
          verificationUrl: null,
          userCode: null,
          message: "GitHub sign-in cancelled.",
        };
        yield* SubscriptionRef.set(flow.state, state);
        return state;
      }),
    );
    if (cancelled === null) return;
    if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
    yield* scheduleStateReap(accountId, flow.entry, flow.flowId);
  });

  const cancel: GitHubOAuth["Service"]["cancel"] = Effect.fn("GitHubOAuth.cancel")(
    function* (accountId, flowId) {
      const flow = active.get(accountId);
      if (!flow || flow.flowId !== flowId) {
        return yield* fail(accountId, "cancel", "This GitHub sign-in is no longer active.");
      }
      yield* cancelActiveFlow(accountId, flow);
      return yield* SubscriptionRef.get(flow.state);
    },
  );

  const subscribe = (accountId: GitHubAccountId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const entry = yield* getState(accountId);
        entry.subscribers += 1;
        const release = Effect.gen(function* () {
          entry.subscribers = Math.max(0, entry.subscribers - 1);
          const flow = active.get(accountId);
          // `start` and `subscribe` are separate RPCs, so retain the flow while
          // any client is observing it and cancel only when the last one leaves.
          if (flow?.entry === entry && entry.subscribers === 0) {
            yield* cancelActiveFlow(accountId, flow);
            return;
          }
          if (
            entry.subscribers === 0 &&
            states.get(accountId) === entry &&
            !active.has(accountId) &&
            ((yield* SubscriptionRef.get(entry.state)).phase === "idle" || entry.reapRequested)
          ) {
            states.delete(accountId);
          }
        });
        return Stream.concat(
          Stream.fromEffect(SubscriptionRef.get(entry.state)),
          SubscriptionRef.changes(entry.state),
        ).pipe(Stream.changes, Stream.ensuring(release));
      }),
    );

  return GitHubOAuth.of({ start, cancel, subscribe });
});

export const layer = Layer.effect(GitHubOAuth, make());
