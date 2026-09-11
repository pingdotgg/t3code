import { Environment } from "@/Railway/ProjectEnvironment.ts";
import { suiteProject } from "../suiteProject.ts";

/**
 * Shared live-test project. This is the cached Effect from
 * `suiteProject`, not a stack Resource — so `stack.destroy()` cannot
 * delete it (failed-test cleanup was wiping `alchsuite-testlive`).
 */
export const Site = suiteProject;

/**
 * Empty extra environment on the suite project. Do not retain — destroy
 * removes the partition. Do not pass `sourceEnvironmentId`.
 */
export const Partition = Environment("Partition", { project: Site });
