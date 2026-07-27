import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const run = Effect.fn(function* (
  bin: string,
  args: string[],
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* ChildProcess.make(bin, args, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: false,
    extendEnv: true,
  }).pipe(
    spawner.spawn,
    Effect.flatMap((child) =>
      Effect.all(
        {
          exitCode: child.exitCode,
          stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
        },
        { concurrency: "unbounded" },
      ),
    ),
  );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new Error(`${bin} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`),
    );
  }
});

/**
 * Deploy-time Action that fetches the AWS HyperPod Helm chart (the
 * MANDATORY dependencies — health-monitoring agent, training operators,
 * device plugins, RBAC — that SageMaker validates before an EKS-orchestrated
 * cluster will attach) and vendors its subcharts. Returns the local chart
 * path for `AWS.EKS.HelmChart` to render.
 */
export const FetchHyperPodChart = Alchemy.Action(
  "FetchHyperPodChart",
  (input: { repo: string }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* Effect.sync(() => process.cwd());
      const cloneDir = path.join(cwd, ".alchemy", "cache", "hyperpod-cli");
      if (!(yield* fs.exists(path.join(cloneDir, "helm_chart")))) {
        yield* run("git", [
          "clone",
          "--depth",
          "1",
          input.repo,
          cloneDir,
        ]);
      }
      const chartPath = path.join(cloneDir, "helm_chart", "HyperPodHelmChart");
      yield* run("helm", ["dependency", "update", chartPath]);
      return { chartPath };
    }),
);
