import { Task } from "@/AWS/ECS/Task.ts";

/**
 * A minimal one-shot Fargate task for the ECS task-control binding tests
 * (`RunTask` / `StopTask` / `DescribeTasks` / `ListTasks`).
 *
 * Honest external form: a pre-built busybox image (mirrored into ECR) whose
 * default command echoes a marker and exits 0 — no Effect program, no impl.
 * Tests that need a long-running task (e.g. StopTask) override the command
 * at `runTask` time via `overrides.containerOverrides` (which replaces the
 * task definition's command).
 *
 * Docker Hub busybox: the public.ecr.aws mirror aggressively rate-limits
 * anonymous pulls during local builds (see fixtures/task.ts).
 */
export default Task("EcsBindingsOneShotTask", {
  image: "busybox:stable",
  command: ["sh", "-c", "echo alchemy-ecs-bindings-oneshot"],
  cpu: 256,
  memory: 512,
  taskName: "alchemy-test-ecs-bindings-oneshot",
});
