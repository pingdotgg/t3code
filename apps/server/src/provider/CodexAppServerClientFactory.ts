import { cacheInOwnerScope } from "@t3tools/shared/lazyService";
import type {
  ProviderInstanceId,
  ThreadId,
  OrchestrationV2ProviderSession,
  CodexSettings,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  {
    readonly open: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly providerSessionId: OrchestrationV2ProviderSession["id"];
      readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
      readonly settings: CodexSettings;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<
      CodexClient.CodexAppServerClient["Service"],
      ProviderAdapter.ProviderAdapterOpenSessionError,
      Scope.Scope
    >;
  }
>()("t3/provider/CodexAppServerClientFactory") {}

export const layer = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const service = yield* cacheInOwnerScope(
      Effect.promise(() => import("../orchestration-v2/Adapters/CodexAdapterV2.ts")).pipe(
        Effect.flatMap((adapter) => Layer.build(adapter.layerAppServerClientFactory)),
        Effect.map((services) => Context.get(services, CodexAppServerClientFactory)),
      ),
    );
    return CodexAppServerClientFactory.of({
      open: (input) => service.pipe(Effect.flatMap((value) => value.open(input))),
    });
  }),
);
