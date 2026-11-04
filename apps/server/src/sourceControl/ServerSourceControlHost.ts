import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveSourceControlHostSecrets } from "./sourceControlHostSecrets.ts";

export const layer = Layer.effect(
  SourceControlHost.SourceControlHost,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const process = yield* VcsProcess.VcsProcess;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const secrets = yield* SecretResolver.SecretResolver;
    return SourceControlHost.SourceControlHost.of({
      settings: {
        get: serverSettings.getSettings,
        getWithSecrets: (kind) =>
          serverSettings.getSettings.pipe(
            Effect.flatMap((settings) =>
              resolveSourceControlHostSecrets(secrets, settings.sourceControlHosts, kind).pipe(
                Effect.map((sourceControlHosts) =>
                  sourceControlHosts === settings.sourceControlHosts
                    ? settings
                    : { ...settings, sourceControlHosts },
                ),
              ),
            ),
          ),
        update: serverSettings.updateSettings,
      },
      process: { run: process.run },
      git: {
        execute: git.execute,
        resolveCommit: git.resolveCommit,
        remotes: (cwd) =>
          vcsRegistry.resolve({ cwd }).pipe(Effect.map((handle) => handle.driver.listRemotes(cwd))),
        readConfigValue: git.readConfigValue,
        resolvePrimaryRemoteName: git.resolvePrimaryRemoteName,
        ensureRemote: git.ensureRemote,
        listLocalBranchNames: git.listLocalBranchNames,
        fetchRemoteBranch: git.fetchRemoteBranch,
        fetchRemoteTrackingBranch: git.fetchRemoteTrackingBranch,
        setBranchUpstream: git.setBranchUpstream,
        createBranch: git.createBranch,
        writeConfigValue: git.writeConfigValue,
        switchRef: git.switchRef,
      },
    });
  }),
).pipe(Layer.provide(SecretResolverLayer.layer));
