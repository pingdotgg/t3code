import {
  ProviderSetupError,
  ProviderAuthInteraction,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

import { withCodexAppServerClient } from "./CodexProvider.ts";

const isAuthInteraction = Schema.is(ProviderAuthInteraction);
const isSetupError = Schema.is(ProviderSetupError);

export const makeCodexCliAuth = Effect.fn("makeCodexCliAuth")(function* (input: {
  instanceId: ProviderInstanceId;
  launch: Parameters<typeof withCodexAppServerClient>[0] & { homePath: string };
  refresh: Effect.Effect<void>;
}) {
  // The app-server belongs to the sign-in scope so cancellation stops it immediately.
  const services = Context.omit(Scope.Scope)(
    yield* Effect.context<Effect.Services<ReturnType<typeof withCodexAppServerClient>>>(),
  );
  const { instanceId, launch } = input;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId, operation, detail });
  const refresh = input.refresh.pipe(Effect.ignoreCause({ log: true }));
  const openClient = withCodexAppServerClient(launch).pipe(Effect.provideContext(services));
  return yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "provider", key: launch.homePath },
    methods: Effect.succeed([
      {
        id: "chatgpt-device-code",
        name: "ChatGPT (device code)",
        description: null,
        type: "agent",
      },
      { id: "chatgpt-browser", name: "ChatGPT (browser)", description: null, type: "agent" },
    ]),
    authenticate: Effect.fn("CodexCliAuth.authenticate")(
      function* (methodId, context) {
        const { client } = yield* openClient;
        const completed = yield* Deferred.make<{ loginId?: string | null; success: boolean }>();
        yield* client.handleServerNotification("account/login/completed", (event) =>
          Deferred.succeed(completed, event).pipe(Effect.asVoid),
        );
        const login = yield* client.request("account/login/start", {
          type: methodId === "chatgpt-browser" ? "chatgpt" : "chatgptDeviceCode",
        });
        if (login.type !== "chatgpt" && login.type !== "chatgptDeviceCode") {
          return yield* failure("start", "Codex returned an unsupported sign-in method.");
        }
        const interaction: ProviderAuthInteraction =
          login.type === "chatgpt"
            ? { type: "browser", id: context.flowId, url: login.authUrl, requiresConsent: false }
            : {
                type: "deviceCode",
                id: context.flowId,
                url: login.verificationUrl,
                userCode: login.userCode,
              };
        if (!isAuthInteraction(interaction)) {
          return yield* failure("start", "Codex did not return valid sign-in instructions.");
        }
        yield* context.setInteraction(interaction);
        const result = yield* Effect.raceFirst(Deferred.await(completed), client.awaitTermination);
        if (result.loginId !== login.loginId || !result.success) {
          return yield* failure("start", "Codex could not complete sign-in. Try again.");
        }
        yield* context.verifying;
        yield* refresh;
      },
      Effect.mapError((error) =>
        isSetupError(error)
          ? error
          : failure(
              "start",
              "Codex could not sign in. Check your Codex CLI version and try again.",
            ),
      ),
    ),
    logout: Effect.gen(function* () {
      const { client } = yield* openClient;
      yield* client.request("account/logout", undefined);
      yield* refresh;
    }).pipe(
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.mapError(() => failure("logout", "Codex could not sign out. Try again.")),
    ),
  });
});
