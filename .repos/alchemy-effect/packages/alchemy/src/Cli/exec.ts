import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "../AlchemyContext.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as RpcProviderProxy from "../Local/RpcProviderProxy.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { execStack, ExecStackOptions } from "./commands/deploy.ts";
import { selectCli } from "./selectCli.ts";

const services = Layer.merge(selectCli(), RpcProviderProxy.fromEnv()).pipe(
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

export const exec = () =>
  execStack(
    Schema.decodeSync(ExecStackOptions)(
      JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS!),
    ),
  ).pipe(Effect.provide(services), Effect.scoped);
