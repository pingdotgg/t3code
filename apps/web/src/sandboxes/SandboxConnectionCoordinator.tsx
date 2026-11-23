import { useAtomValue } from "@effect/atom-react";
import { isSandboxBeingDeleted } from "@t3tools/client-runtime/sandboxes";
import { sandboxSettingsSeed } from "@t3tools/client-runtime/sandboxes/settings-seed";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  requiredScopesForServerSettingsPatch,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { useEnvironmentPresentation } from "../state/presentation";
import { useEnvironmentQuery } from "../state/query";
import { sandboxEnvironment } from "../state/sandboxes";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnsureSandboxProject } from "./sandboxProjects";
import { useSandboxes } from "./useSandboxes";

/**
 * Gives each Sandbox environment its project once connected, and the preferences changed on its
 * host once. Connecting follows the host's Sandbox list in client-runtime.
 */
export function SandboxConnectionCoordinator() {
  const sandboxes = useSandboxes();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const knownEnvironmentIds = useRef(new Set<string>());

  // A deleted Sandbox takes its environment along; leave a thread view on it.
  const leaveRemovedEnvironment = useEffectEvent((removed: ReadonlyArray<string>) => {
    if (removed.some((environmentId) => pathname.startsWith(`/${environmentId}/`))) {
      void navigate({ to: "/" });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- router: leaves a thread view whose Sandbox environment the host dropped
  useEffect(() => {
    const current = new Set<string>(
      sandboxes.flatMap((sandbox) =>
        sandbox.environmentId === null || isSandboxBeingDeleted(sandbox)
          ? []
          : [sandbox.environmentId],
      ),
    );
    const removed = [...knownEnvironmentIds.current].filter((id) => !current.has(id));
    knownEnvironmentIds.current = current;
    if (removed.length > 0) leaveRemovedEnvironment(removed);
  }, [sandboxes]);

  return sandboxes.map((sandbox) =>
    sandbox.environmentId === null ? null : (
      <SandboxEnvironmentCoordinator
        key={`${sandbox.hostEnvironmentId}:${sandbox.name}:${sandbox.environmentId}`}
        name={sandbox.name}
        hostEnvironmentId={sandbox.hostEnvironmentId}
        environmentId={EnvironmentId.make(sandbox.environmentId)}
        workingDirectory={sandbox.workingDirectory}
        settingsSeeded={sandbox.settingsSeeded}
        harnesses={sandbox.harnesses}
      />
    ),
  );
}

function SandboxEnvironmentCoordinator(props: {
  readonly name: string;
  readonly hostEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly workingDirectory: string | null;
  readonly settingsSeeded: boolean;
  readonly harnesses: ReadonlyArray<string>;
}) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(props.environmentId));
  const ensureProject = useEnsureSandboxProject();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const markSettingsSeeded = useAtomCommand(sandboxEnvironment.markSettingsSeeded, {
    reportFailure: false,
  });
  const localConfig = useAtomValue(serverEnvironment.configValueAtom(props.hostEnvironmentId));
  const sandboxConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  // The Sandbox's providers arrive after it connects; waiting for them keeps
  // model selections from being skipped for good.
  const configsLoaded =
    localConfig !== null && sandboxConfig !== null && sandboxConfig.providers.length > 0;
  const seeding = useRef(false);
  const connected = presentation?.connection.phase === "connected";
  // Only a live project list can show the project is missing; a cached one may predate a removal.
  const ready = connected && shell.data?.status === "live" && shell.data.snapshot._tag === "Some";

  // Each connect makes sure the Sandbox has its project, so a removed one comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connection: each connect to the Sandbox's server ensures its project
  useEffect(() => {
    if (!ready || props.workingDirectory === null) return;
    void ensureProject({
      name: props.name,
      environmentId: props.environmentId,
      workingDirectory: props.workingDirectory,
    }).then((error) => {
      if (error !== null) console.warn("Could not add the Sandbox project.", error);
    });
  }, [ready, ensureProject, props.name, props.environmentId, props.workingDirectory]);

  // A new Sandbox starts with the preferences changed on its host, once,
  // so a later deliberate choice in the Sandbox is never undone.
  const seedSettings = useEffectEvent(async () => {
    if (seeding.current || props.settingsSeeded || !configsLoaded) {
      return;
    }
    seeding.current = true;
    const run = async () => {
      const seed = sandboxSettingsSeed({
        local: localConfig.settings,
        sandbox: sandboxConfig.settings,
        sandboxProviderInstanceIds: new Set(
          sandboxConfig.providers
            .filter((provider) => provider.enabled)
            .map((provider) => provider.instanceId),
        ),
        harnesses: props.harnesses,
        ...(sandboxConfig.managedPolicy === undefined
          ? {}
          : { sandboxPolicy: sandboxConfig.managedPolicy }),
      });
      const changesSettings = Object.keys(seed.patch).length > 0;
      if (changesSettings || seed.providerInstanceMutation !== undefined) {
        const scopes = [
          ...(changesSettings ? requiredScopesForServerSettingsPatch(seed.patch) : []),
          ...(seed.providerInstanceMutation !== undefined ? [AuthProvidersManageScope] : []),
        ];
        if (!scopes.every((scope) => readEnvironmentScope(props.environmentId, scope))) return;
        const result = await updateSettings({ environmentId: props.environmentId, input: seed });
        if (result._tag === "Failure") {
          console.warn("Could not seed the Sandbox settings.");
          return;
        }
      }
      await markSettingsSeeded({
        environmentId: props.hostEnvironmentId,
        input: { name: props.name, environmentId: props.environmentId },
      });
    };
    // `.finally` rather than try/finally, which the React Compiler cannot compile.
    await run().finally(() => {
      seeding.current = false;
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connection: seeds the Sandbox's server once it and its host have their configs
  useEffect(() => {
    if (ready && configsLoaded) void seedSettings();
  }, [ready, configsLoaded]);

  return null;
}
