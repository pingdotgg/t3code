import { join } from "node:path";

import { seedPerfState } from "../integration/perf/seedPerfState.ts";
import { getPerfSeedScenario } from "@t3tools/shared/perf/scenarioCatalog";

const PERF_SEED_JSON_START = "__T3_PERF_SEED_JSON_START__";
const PERF_SEED_JSON_END = "__T3_PERF_SEED_JSON_END__";
const scenarioId = process.argv[2];

if (scenarioId !== "large_threads" && scenarioId !== "burst_base") {
  console.error(`Expected a perf seed scenario id, received '${scenarioId ?? "<missing>"}'.`);
  process.exit(1);
}

const seeded = await seedPerfState(scenarioId);
const scenario = getPerfSeedScenario(scenarioId);
const scenarioProjectById = new Map(scenario.projects.map((project) => [project.id, project]));
const scenarioThreadById = new Map(scenario.threads.map((thread) => [thread.id, thread]));
const projectById = new Map(seeded.snapshot.projects.map((project) => [project.id, project]));
const payload = JSON.stringify(
  {
    scenarioId: seeded.scenarioId,
    runParentDir: seeded.runParentDir,
    baseDir: seeded.baseDir,
    workspaceRoot: seeded.workspaceRoot,
    projectTitle: seeded.snapshot.projects[0]?.title ?? null,
    projectSummaries: seeded.snapshot.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot:
        scenarioProjectById.get(project.id)?.workspaceDirectoryName !== undefined
          ? join(seeded.baseDir, scenarioProjectById.get(project.id)?.workspaceDirectoryName ?? "")
          : project.workspaceRoot,
      threadCount: seeded.snapshot.threads.filter((thread) => thread.projectId === project.id)
        .length,
    })),
    threadSummaries: seeded.snapshot.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      projectTitle: projectById.get(thread.projectId)?.title ?? null,
      title: thread.title,
      turnCount: scenarioThreadById.get(thread.id)?.turnCount ?? null,
      messageCount: thread.messages.length,
      activityCount: thread.activities.length,
      proposedPlanCount: thread.proposedPlans.length,
      checkpointCount: thread.checkpoints.length,
    })),
  },
  null,
  2,
);
process.stdout.write(`${PERF_SEED_JSON_START}\n${payload}\n${PERF_SEED_JSON_END}\n`);
