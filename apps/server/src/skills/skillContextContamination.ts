import type { OrchestrationV2TurnItem, SkillTurnResolution } from "@t3tools/contracts";

import { matchesNativeSkillName } from "./nativeSkillName.ts";

export interface ActivatedSkillContext {
  readonly skillName: string;
  readonly mode: "base" | "variant" | "off";
  readonly contentHash: string | null;
  readonly variantPath: string | null;
  readonly skillPath: string | null;
}

export interface SkillContextOmission {
  readonly skillName: string;
  readonly variantPaths: ReadonlyArray<string>;
  readonly skillPaths: ReadonlyArray<string>;
}

export const SKILL_CONTEXT_OMISSION_PLACEHOLDER =
  "[skill content omitted: not used with the current model]";

const normalizeSkillName = (skillName: string) => skillName.trim().toLowerCase();

const normalizePathPayload = (value: string) =>
  value.toLowerCase().replaceAll("\\\\", "/").replaceAll("\\", "/");

const pathDirectory = (value: string) => {
  const normalized = normalizePathPayload(value);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? normalized : normalized.slice(0, separator + 1);
};

function samePolicy(
  activated: ActivatedSkillContext,
  target: SkillTurnResolution["entries"][number] | undefined,
): boolean {
  const targetMode = target?.mode ?? "base";
  if (activated.mode === "base") return targetMode === "base";
  if (activated.mode !== "variant" || target === undefined || target.mode !== "variant") {
    return false;
  }
  return (
    activated.contentHash !== null &&
    target.contentHash !== null &&
    activated.contentHash === target.contentHash
  );
}

export function contaminatingSkillContexts(input: {
  readonly activated: ReadonlyArray<ActivatedSkillContext>;
  readonly targetResolution: SkillTurnResolution;
}): ReadonlyArray<SkillContextOmission> {
  const targetEntries = new Map(
    input.targetResolution.entries.map((entry) => [normalizeSkillName(entry.skillName), entry]),
  );
  const contaminating = new Map<
    string,
    { readonly variantPaths: Set<string>; readonly skillPaths: Set<string> }
  >();
  for (const activated of input.activated) {
    const skillName = normalizeSkillName(activated.skillName);
    if (skillName === "") continue;
    const target = targetEntries.get(skillName);
    if (target?.mode !== "off" && samePolicy(activated, target)) continue;
    const paths = contaminating.get(skillName) ?? {
      variantPaths: new Set<string>(),
      skillPaths: new Set<string>(),
    };
    if (activated.variantPath !== null && activated.variantPath.trim() !== "") {
      paths.variantPaths.add(activated.variantPath);
    }
    if (activated.skillPath !== null && activated.skillPath.trim() !== "") {
      paths.skillPaths.add(activated.skillPath);
    }
    contaminating.set(skillName, paths);
  }
  return [...contaminating.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([skillName, paths]) => ({
      skillName,
      variantPaths: [...paths.variantPaths].sort(),
      skillPaths: [...paths.skillPaths].sort(),
    }));
}

export function turnItemCarriesOmittedSkillContext(
  item: OrchestrationV2TurnItem,
  omissions: ReadonlyArray<SkillContextOmission>,
): boolean {
  if (item.type === "user_message" || item.type === "assistant_message") return false;
  const payload = normalizePathPayload(JSON.stringify(item));
  return omissions.some((omission) => {
    const skillName = normalizeSkillName(omission.skillName);
    if (skillName === "") return false;
    if (
      item.type === "dynamic_tool" &&
      item.toolName?.toLowerCase() === "skill" &&
      matchesNativeSkillName(item.input, skillName)
    ) {
      return true;
    }
    if (
      omission.skillPaths.some((path) => {
        const normalizedPath = normalizePathPayload(path);
        return payload.includes(normalizedPath) || payload.includes(pathDirectory(normalizedPath));
      })
    ) {
      return true;
    }
    return omission.variantPaths.some((path) => payload.includes(normalizePathPayload(path)));
  });
}
