import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  ProviderDriverKind,
  SkillInventory,
  SkillInventoryInstallation,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_SKILL_INVENTORY_TIMEOUT_MS = 10_000;
const HOME_DIRECTORY_PREFIX = /^(?:\/(?:home|Users)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;

/** Shortens a skill directory for display while preserving its useful tail. */
export function formatSkillPath(path: string): string {
  const homeRelative = path.replace(HOME_DIRECTORY_PREFIX, "~");
  const segments = homeRelative.split(/[/\\]/).filter(Boolean);
  if (segments.length <= 4) return homeRelative;
  return `…/${segments.slice(-3).join("/")}`;
}

export function filterSkillInventory(inventory: SkillInventory, query: string): SkillInventory {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return inventory;
  return {
    ...inventory,
    installations: inventory.installations.filter((skill) =>
      [skill.name, skill.description ?? "", skill.directoryPath, skill.harnessDisplayName].some(
        (value) => value.toLowerCase().includes(normalizedQuery),
      ),
    ),
  };
}

export function displayedSkillCount(
  inventory: SkillInventory | null,
  isConnected: boolean,
): number | null {
  if (!isConnected || !inventory) return null;
  return inventory.installations.length;
}

export function formatSkillCount(total: number, visible?: number): string {
  if (visible !== undefined && visible !== total) return `${visible} of ${total} skills`;
  return `${total} ${total === 1 ? "skill" : "skills"}`;
}

export function setKeyCollapsed(
  keys: ReadonlySet<string>,
  key: string,
  collapsed: boolean,
): ReadonlySet<string> {
  const next = new Set(keys);
  if (collapsed) next.add(key);
  else next.delete(key);
  return next;
}

export interface SkillHarnessGroup {
  readonly key: string;
  readonly harness: ProviderDriverKind;
  readonly harnessDisplayName: string;
  readonly rootPath: string | null;
  readonly skills: ReadonlyArray<SkillInventoryInstallation>;
}

/** Stable identity for a single installation, unique within an inventory. */
export function skillKey(skill: SkillInventoryInstallation): string {
  return `${skill.providerInstanceId}:${skill.directoryPath}`;
}

function parentDirectory(path: string): string {
  const parent = path.replace(/[/\\]+[^/\\]+[/\\]*$/, "");
  return parent || path;
}

export function groupSkillsByHarness(
  installations: ReadonlyArray<SkillInventoryInstallation>,
): ReadonlyArray<SkillHarnessGroup> {
  const groups = new Map<string, SkillInventoryInstallation[]>();
  for (const skill of installations) {
    const key = `${skill.providerInstanceId}\0${skill.harnessDisplayName}`;
    const existing = groups.get(key);
    if (existing) existing.push(skill);
    else groups.set(key, [skill]);
  }
  return [...groups.entries()].map(([key, skills]) => {
    const roots = new Set(skills.map((skill) => parentDirectory(skill.directoryPath)));
    return {
      key,
      harness: skills[0]!.harness,
      harnessDisplayName: skills[0]?.harnessDisplayName ?? key,
      rootPath: roots.size === 1 ? ([...roots][0] ?? null) : null,
      skills,
    };
  });
}

export function skillContentForDisplay(content: string): string | null {
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const fetchEnvironmentSkillInventory = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSkillInventory",
)(function* (input: { readonly prepared: PreparedConnection; readonly timeoutMs?: number }) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/skills");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    Option.isSome(signer) ? signer : Option.none(),
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_SKILL_INVENTORY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.skills.inventory({ headers }),
    ),
  );
});
