import {
  GitHubOAuthError,
  type GitHubAccount,
  type GitHubAccountId,
  type GitHubAccountPatch,
  type GitHubOAuthStartInput,
  type GitHubOAuthState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

interface ActiveFlow {
  readonly flowId: string;
  readonly state: SubscriptionRef.SubscriptionRef<GitHubOAuthState>;
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

const accountPatch = (account: GitHubAccount): GitHubAccountPatch => ({
  label: account.label,
  ...(account.login ? { login: account.login } : {}),
  host: account.host,
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
  const states = new Map<GitHubAccountId, SubscriptionRef.SubscriptionRef<GitHubOAuthState>>();
  const active = new Map<GitHubAccountId, ActiveFlow>();

  const getState = Effect.fn("GitHubOAuth.getState")(function* (accountId: GitHubAccountId) {
    const existing = states.get(accountId);
    if (existing) return existing;
    const created = yield* SubscriptionRef.make(idleState(accountId));
    states.set(accountId, created);
    return created;
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
    token: string,
    login: string,
  ) {
    const current = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        fail(input.accountId, "save", "Could not read GitHub account settings.", cause),
      ),
    );
    const githubAccounts = Object.fromEntries(
      Object.entries(current.githubAccounts).map(([id, account]) => [id, accountPatch(account)]),
    );
    const updated = yield* serverSettings
      .updateSettings({
        githubAccounts: {
          ...githubAccounts,
          [input.accountId]: { label: input.label, login, host: input.host, token },
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          fail(input.accountId, "save", "Could not save the GitHub OAuth credential.", cause),
        ),
      );
    return updated.githubAccounts[input.accountId]!;
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
    const account = yield* persistCredential(input, token, login);
    if (active.get(input.accountId) !== flow) return;
    active.delete(input.accountId);
    yield* SubscriptionRef.set(flow.state, {
      accountId: input.accountId,
      phase: "succeeded",
      flowId: flow.flowId,
      verificationUrl: null,
      userCode: null,
      account,
      message: `Signed in as ${login}.`,
    });
  });

  const start: GitHubOAuth["Service"]["start"] = Effect.fn("GitHubOAuth.start")(function* (input) {
    const previous = active.get(input.accountId);
    if (previous?.fiber) yield* Fiber.interrupt(previous.fiber);
    const state = yield* getState(input.accountId);
    const flowId = Encoding.encodeBase64Url(
      yield* crypto
        .randomBytes(18)
        .pipe(
          Effect.mapError((cause) =>
            fail(input.accountId, "start", "Could not start GitHub sign-in.", cause),
          ),
        ),
    );
    const flow: ActiveFlow = { flowId, state };
    active.set(input.accountId, flow);
    const starting: GitHubOAuthState = {
      accountId: input.accountId,
      phase: "starting",
      flowId,
      verificationUrl: null,
      userCode: null,
      account: null,
      message: "Starting GitHub sign-in.",
    };
    yield* SubscriptionRef.set(state, starting);
    const fiber = yield* runFlow(input, flow).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (active.get(input.accountId) !== flow) return;
          active.delete(input.accountId);
          yield* SubscriptionRef.update(state, (current): GitHubOAuthState => ({
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
    return starting;
  });

  const cancel: GitHubOAuth["Service"]["cancel"] = Effect.fn("GitHubOAuth.cancel")(
    function* (accountId, flowId) {
      const flow = active.get(accountId);
      if (!flow || flow.flowId !== flowId) {
        return yield* fail(accountId, "cancel", "This GitHub sign-in is no longer active.");
      }
      active.delete(accountId);
      if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
      const cancelled: GitHubOAuthState = {
        ...(yield* SubscriptionRef.get(flow.state)),
        phase: "cancelled",
        verificationUrl: null,
        userCode: null,
        message: "GitHub sign-in cancelled.",
      };
      yield* SubscriptionRef.set(flow.state, cancelled);
      return cancelled;
    },
  );

  const subscribe = (accountId: GitHubAccountId) =>
    Stream.unwrap(
      getState(accountId).pipe(
        Effect.map((state) =>
          Stream.concat(
            Stream.fromEffect(SubscriptionRef.get(state)),
            SubscriptionRef.changes(state),
          ).pipe(Stream.changes),
        ),
      ),
    );

  return GitHubOAuth.of({ start, cancel, subscribe });
});

export const layer = Layer.effect(GitHubOAuth, make());
