import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ConnectAccountDriver } from "@t3tools/shared/desktopConnect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as CliTokenManager from "./cloud/CliTokenManager.ts";
import { ServerConfig } from "./config.ts";
import { resolveCliAuthConfig } from "./cli/config.ts";
import { discoverAccountEnvironments, withAccountEnvironment } from "./cli/accountEnvironment.ts";

export function createDesktopAccountDriver(input: {
  readonly baseDir: string;
  readonly openBrowser: (url: string) => Promise<void>;
}): ConnectAccountDriver {
  let loginController: AbortController | undefined;
  let authorizationQueue = Promise.resolve();
  const serialize = <A>(run: () => Promise<A>): Promise<A> => {
    const result = authorizationQueue.then(run);
    authorizationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const withTokens = <A, E>(
    run: (tokens: CliTokenManager.CloudCliTokenManager["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(input.baseDir) },
        Option.none(),
      );
      const tokens = Layer.effect(
        CliTokenManager.CloudCliTokenManager,
        CliTokenManager.makeWithBrowser((url) =>
          Effect.tryPromise({
            try: () => input.openBrowser(url),
            catch: (cause) => new CliTokenManager.CloudCliAuthorizationError({ cause }),
          }),
        ),
      ).pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provideMerge(FetchHttpClient.layer),
      );
      return yield* Effect.gen(function* () {
        return yield* run(yield* CliTokenManager.CloudCliTokenManager);
      }).pipe(Effect.provide(tokens));
    }).pipe(Effect.provide(NodeServices.layer));
  let tokensPromise: Promise<CliTokenManager.CloudCliTokenManager["Service"]> | undefined;
  const getTokens = () =>
    (tokensPromise ??= Effect.runPromise(withTokens(Effect.succeed)).catch((error) => {
      tokensPromise = undefined;
      throw error;
    }));
  const runTokens = async <A, E>(
    run: (tokens: CliTokenManager.CloudCliTokenManager["Service"]) => Effect.Effect<A, E>,
    signal?: AbortSignal,
  ) =>
    Effect.runPromise(
      run(await getTokens()).pipe(Effect.provide(FetchHttpClient.layer)),
      signal ? { signal } : undefined,
    );

  return {
    async login() {
      loginController?.abort();
      const controller = new AbortController();
      loginController = controller;
      try {
        await runTokens((tokens) => tokens.get, controller.signal);
      } finally {
        if (loginController === controller) loginController = undefined;
      }
    },
    async logout() {
      loginController?.abort();
      await runTokens((tokens) => tokens.clear);
    },
    discover: () =>
      serialize(async () => {
        const existing = await runTokens((tokens) => tokens.getExisting);
        if (Option.isNone(existing)) return null;
        const result = await Effect.runPromise(
          discoverAccountEnvironments(input.baseDir, await getTokens()).pipe(
            Effect.provide(NodeServices.layer),
          ),
        );
        return {
          accountId: result.session.accountId,
          identity: result.session.identity ?? result.session.accountId,
          environments: result.environments.map((environment) => ({
            environmentId: environment.environmentId,
            label: environment.label,
          })),
        };
      }),
    connect: (accountId, environmentId) =>
      serialize(async () => {
        const target = await Effect.runPromise(
          withAccountEnvironment(
            input.baseDir,
            { accountId, environmentId },
            Effect.succeed,
            await getTokens(),
          ).pipe(Effect.provide(NodeServices.layer)),
        );
        return {
          httpBaseUrl: target.origin,
          nextSocketUrl: () => Effect.runPromise(target.nextSocketUrl),
          request: (path, request) => Effect.runPromise(target.request(path, request)),
        };
      }),
  };
}
