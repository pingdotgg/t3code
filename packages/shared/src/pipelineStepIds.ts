import { PIPELINE_STEP_ID_MAX_LENGTH } from "@t3tools/contracts";

export function slugifyStepName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PIPELINE_STEP_ID_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "step";
}

/** Returns `base`, or `base-2`, `base-3`, ... when `base` is taken; the suffix keeps the id within its length limit. */
export function uniqueStepId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, PIPELINE_STEP_ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Saved ids never change, so references in other templates and old runs keep working. */
export function resolveStepIds(
  steps: ReadonlyArray<{ readonly lockedId: string | null; readonly name: string }>,
): ReadonlyArray<string> {
  const taken = new Set<string>();
  for (const step of steps) if (step.lockedId !== null) taken.add(step.lockedId);
  return steps.map((step) => {
    if (step.lockedId !== null) return step.lockedId;
    const id = uniqueStepId(slugifyStepName(step.name), taken);
    taken.add(id);
    return id;
  });
}
