import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import packageJson from "../../package.json" with { type: "json" };

import { checkLatestVersion } from "./checkVersion.ts";
import { handleCancellation } from "./commands/_shared.ts";
import { awsCommand } from "./commands/aws.ts";
import { cloudflareCommand } from "./commands/cloudflare.ts";
import {
  deployCommand,
  destroyCommand,
  planCommand,
} from "./commands/deploy.ts";
import { devCommand } from "./commands/dev.ts";
import { loginCommand } from "./commands/login.ts";
import { logsCommand } from "./commands/logs.ts";
import { unsafeCommand } from "./commands/nuke.ts";
import { profileCommand } from "./commands/profile.ts";
import { stateCommand } from "./commands/state.ts";
import { syncCommand } from "./commands/sync.ts";
import { tailCommand } from "./commands/tail.ts";
import { selectCli } from "./selectCli.ts";

const root = Command.make("alchemy", {}).pipe(
  Command.withSubcommands([
    awsCommand,
    cloudflareCommand,
    deployCommand,
    devCommand,
    destroyCommand,
    planCommand,
    tailCommand,
    logsCommand,
    loginCommand,
    profileCommand,
    stateCommand,
    syncCommand,
    unsafeCommand,
  ]),
);

const cli = Command.run(root, {
  // name: "Alchemy Effect CLI",
  version: packageJson.version,
});

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
  // Ambient per-CLI-run artifact root. Commands that define their own run
  // boundary (deploy, sync) provide a fresh store closer to the work, which
  // wins over this one.
  Layer.succeed(ArtifactStore, createArtifactStore()),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  TelemetryLive,
  selectCli(),
);

const program = Effect.gen(function* () {
  // Best-effort, non-blocking check for a newer published version. If the
  // CLI command finishes before the registry responds, the fiber is
  // interrupted on scope close — that's intentional.
  yield* checkLatestVersion.pipe(Effect.forkScoped);
  return yield* cli;
});

export const main = program.pipe(
  // $USER and $STAGE are set by the environment
  Effect.provide(services),
  Effect.scoped,
  handleCancellation,
);
