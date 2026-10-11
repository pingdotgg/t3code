import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type ServerConfig,
  type SkillFolderInfo,
} from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { NetworkIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useContext, useMemo } from "react";

import { serverEnvironment } from "../../state/server";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A connected environment the Skills tab reads, in the order rows prefer them. */
export interface SkillEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: ServerConfig | null;
  /** The project's checkout there, at project scope. */
  readonly cwd: string | null;
}

const EMPTY: ReadonlyArray<never> = [];

/**
 * Each environment's provider list, read together. The lists already stream
 * to the client with each environment's config, so this adds no requests.
 * Keyed by the ids alone: they decide which atoms are read.
 */
const providersByEnvironment = Atom.family((key: string) =>
  Atom.make((get) =>
    (key === "" ? [] : (key.split(",") as EnvironmentId[])).map((environmentId) => ({
      environmentId,
      providers: get(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY,
    })),
  ).pipe(Atom.withLabel(`web:skill-environment-providers:${key}`)),
);

export function useEnvironmentProviders(environments: ReadonlyArray<SkillEnvironment>) {
  return useAtomValue(
    providersByEnvironment(environments.map((environment) => environment.environmentId).join(",")),
  );
}

/** An environment and the checkout to inspect there, as a family key. */
const folderKey = (environment: SkillEnvironment) =>
  JSON.stringify([environment.environmentId, environment.cwd]);

const inspectAtom = (key: string) => {
  const [environmentId, cwd] = JSON.parse(key) as [EnvironmentId, string | null];
  return serverEnvironment.inspectSkills({
    environmentId,
    input: cwd === null ? {} : { cwd },
  });
};

const foldersByEnvironment = Atom.family((keys: string) =>
  Atom.make((get) =>
    (JSON.parse(keys) as string[]).map((key) => ({
      environmentId: (JSON.parse(key) as [EnvironmentId])[0],
      result: get(inspectAtom(key)),
    })),
  ).pipe(Atom.withLabel(`web:skill-environment-folders:${keys}`)),
);

/**
 * Each environment's inspected skill folders, by the SKILL.md path its agents
 * reported. Paths are per machine (two Macs share `/Users/me`), so they stay
 * keyed by environment.
 */
export function useEnvironmentSkillFolders(environments: ReadonlyArray<SkillEnvironment>) {
  const keys = JSON.stringify(environments.map(folderKey));
  const results = useAtomValue(foldersByEnvironment(keys));
  const registry = useContext(RegistryContext);
  const refresh = useCallback(() => {
    for (const key of JSON.parse(keys) as string[]) registry.refresh(inspectAtom(key));
  }, [keys, registry]);
  const folders = useMemo(
    () =>
      new Map(
        results.map(({ environmentId, result }) => [
          environmentId,
          new Map<string, SkillFolderInfo>(
            (Option.getOrNull(AsyncResult.value(result))?.folders ?? []).map((folder) => [
              folder.path,
              folder,
            ]),
          ),
        ]),
      ),
    [results],
  );
  return { folders, refresh };
}

/**
 * Where a skill is, at a glance: a fleet mark when every environment listed
 * has it, otherwise the machines that do.
 */
export function SkillEnvironmentMarks({
  on,
  environments,
}: {
  on: ReadonlyArray<EnvironmentId>;
  environments: ReadonlyArray<SkillEnvironment>;
}) {
  const present = environments.filter((environment) => on.includes(environment.environmentId));
  const missing = environments.filter((environment) => !on.includes(environment.environmentId));
  const label =
    missing.length === 0
      ? `On all ${environments.length} environments`
      : `On ${present.map((environment) => environment.label).join(", ")}; not on ${missing
          .map((environment) => environment.label)
          .join(", ")}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="flex shrink-0 items-center gap-1 text-muted-foreground"
          />
        }
      >
        {missing.length === 0 ? (
          <NetworkIcon className="size-4" />
        ) : (
          present.map((environment) => (
            <EnvironmentMachineIcon
              key={environment.environmentId}
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-4"
            />
          ))
        )}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
