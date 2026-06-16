import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

export const HostProcessPlatform = Context.Reference<NodeJS.Platform>(
  "@t3tools/shared/hostProcess/HostProcessPlatform",
  {
    defaultValue: () => process.platform,
  },
);

export const HostProcessArchitecture = Context.Reference<NodeJS.Architecture>(
  "@t3tools/shared/hostProcess/HostProcessArchitecture",
  {
    defaultValue: () => process.arch,
  },
);

export const HostProcessHostname = Context.Reference<string>(
  "@t3tools/shared/hostProcess/HostProcessHostname",
  {
    defaultValue: () => NodeOS.hostname(),
  },
);

export const HostProcessEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "@t3tools/shared/hostProcess/HostProcessEnvironment",
  {
    defaultValue: () => process.env,
  },
);

export const isHostWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
