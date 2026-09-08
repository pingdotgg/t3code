import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "../AlchemyContext.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as RpcProviderProxy from "../Local/RpcProviderProxy.ts";
import { forwardSidecarLogs } from "../Local/RpcSpawner.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { execStack, ExecStackOptions } from "./commands/deploy.ts";
import { LoggingCli } from "./LoggingCli.ts";
import { selectCli } from "./selectCli.ts";

// `alchemy dev` is a long-running session whose primary output is the log
// stream (worker starts, cron fires, request logs) interleaved with
// re-applies on file change. Ink's insertion model stacks inserted lines
// ABOVE the animated region, so runtime logs end up above the plan/apply
// output in scrollback. Append-only chronological rendering is the correct
// model for a dev server (plan → status → logs, strictly in order), so dev
// always takes the line renderer; deploy/destroy keep the interactive TUI.
const makeServices = (dev: boolean | undefined) =>
  Layer.merge(dev ? LoggingCli : selectCli(), RpcProviderProxy.fromEnv()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(AlchemyContextLive, ProfileLive, CredentialsStoreLive),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        PlatformServices,
        FetchHttpClient.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv()),
      ),
    ),
  );

export const exec = () => {
  const options = Schema.decodeSync(ExecStackOptions)(
    JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
  );
  // Subscribe to the spawner's sidecar log stream BEFORE the stack runs:
  // this process owns the terminal renderer, so sidecar output printed here
  // lands in chronological order with the run's own lines instead of racing
  // the shared tty. No-op outside dev.
  return forwardSidecarLogs.pipe(
    Effect.andThen(execStack(options)),
    Effect.provide(makeServices(options.dev)),
    Effect.scoped,
  );
};
