import { useAtomValue } from "@effect/atom-react";
import { isSandboxBeingDeleted } from "@t3tools/client-runtime/sandboxes";
import { ensureSandboxProject } from "@t3tools/client-runtime/sandboxes/projects";
import { seedSandboxSettings } from "@t3tools/client-runtime/sandboxes/settings-seed";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ProjectId, type EnvironmentId } from "@t3tools/contracts";
import { StackActions } from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef } from "react";

import { rootNavigationRef } from "../../lib/rootNavigation";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentPresentation } from "../../state/presentation";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { sandboxEnvironment } from "../../state/sandboxes";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

const routeEnvironmentId = (params: object | undefined): string | undefined => {
  const value = (params as { readonly environmentId?: string | ReadonlyArray<string> } | undefined)
    ?.environmentId;
  return typeof value === "string" ? value : value?.[0];
};

/** A deleted Sandbox takes its environment along, so a view open on one goes home. */
function leaveRemovedEnvironments(removed: ReadonlyArray<string>) {
  if (!rootNavigationRef.isReady()) return;
  const routes = rootNavigationRef.getRootState()?.routes ?? [];
  const open = routes.some((route) => {
    const environmentId = routeEnvironmentId(route.params);
    return environmentId !== undefined && removed.includes(environmentId);
  });
  if (open) rootNavigationRef.dispatch(StackActions.popTo("Home"));
}

/**
 * Gives each Sandbox environment its project once connected, and the preferences changed on its
 * host once, as the web client does. Connecting follows the host's Sandbox list in client-runtime.
 */
export function SandboxCoordinator() {
  const sandboxes = useAtomValue(sandboxEnvironment.sandboxesAtom);
  const knownEnvironmentIds = useRef(new Set<string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigation: leaves a thread view whose Sandbox environment the host dropped
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
    if (removed.length > 0) leaveRemovedEnvironments(removed);
  }, [sandboxes]);

  return sandboxes.map((sandbox) =>
    sandbox.environmentId === null ? null : (
      <SandboxEnvironmentCoordinator
        key={`${sandbox.hostEnvironmentId}:${sandbox.name}:${sandbox.environmentId}`}
        name={sandbox.name}
        hostEnvironmentId={sandbox.hostEnvironmentId}
        environmentId={sandbox.environmentId}
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
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const markSettingsSeeded = useAtomCommand(sandboxEnvironment.markSettingsSeeded, {
    reportFailure: false,
  });
  const hostConfig = useAtomValue(serverEnvironment.configValueAtom(props.hostEnvironmentId));
  const sandboxConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  // The Sandbox's providers arrive after it connects; waiting for them keeps
  // model selections from being skipped for good.
  const configsLoaded =
    hostConfig !== null && sandboxConfig !== null && sandboxConfig.providers.length > 0;
  const seeding = useRef(false);
  const connected = presentation?.connection.phase === "connected";
  // Only a live project list can show the project is missing; a cached one may predate a removal.
  const ready = connected && shell.data?.status === "live" && shell.data.snapshot._tag === "Some";

  const ensureProject = useEffectEvent((workingDirectory: string) => {
    void ensureSandboxProject(
      {
        hasProjectAt: (environmentId, workspaceRoot) =>
          findProjectByPath(
            appAtomRegistry
              .get(environmentProjects.projectsAtom)
              .filter((project) => project.environmentId === environmentId),
            workspaceRoot,
          ) !== undefined,
        createProject: async ({ environmentId, title, workspaceRoot }) => {
          const result = await createProject({
            environmentId,
            input: {
              projectId: ProjectId.make(uuidv4()),
              title,
              workspaceRoot,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (result._tag !== "Failure") return null;
          const failure = squashAtomCommandFailure(result);
          return failure instanceof Error ? failure.message : "Could not add the project.";
        },
      },
      { name: props.name, environmentId: props.environmentId, workingDirectory },
    ).then((error) => {
      if (error !== null) console.warn("Could not add the Sandbox project.", error);
    });
  });
  // Each connect makes sure the Sandbox has its project, so a removed one comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connection: each connect to the Sandbox's server ensures its project
  useEffect(() => {
    if (ready && props.workingDirectory !== null) ensureProject(props.workingDirectory);
  }, [ready, props.workingDirectory]);

  const seedSettings = useEffectEvent(() => {
    if (seeding.current || props.settingsSeeded || hostConfig === null || sandboxConfig === null) {
      return;
    }
    seeding.current = true;
    void seedSandboxSettings({
      hostConfig,
      sandboxConfig,
      harnesses: props.harnesses,
      hasScope: (scope) => readEnvironmentScope(props.environmentId, scope),
      updateSettings: async (seed) => {
        const result = await updateSettings({ environmentId: props.environmentId, input: seed });
        if (result._tag === "Failure") console.warn("Could not seed the Sandbox settings.");
        return result._tag !== "Failure";
      },
      markSeeded: () =>
        markSettingsSeeded({
          environmentId: props.hostEnvironmentId,
          input: { name: props.name, environmentId: props.environmentId },
        }),
    }).finally(() => {
      seeding.current = false;
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connection: seeds the Sandbox's server once it and its host have their configs
  useEffect(() => {
    if (ready && configsLoaded) seedSettings();
  }, [ready, configsLoaded]);

  return null;
}
