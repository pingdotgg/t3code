/**
 * Internal Helm rendering for `AWS.EKS.HelmChart`.
 *
 * Renders a chart to plain Kubernetes objects with the local `helm` CLI
 * (`helm template` — pure local templating, no cluster connection, no
 * in-cluster release records), so the rendered objects flow through the same
 * server-side-apply machinery as `AWS.EKS.Manifest` and the platforms.
 * Mirrors the `Docker` service's local-CLI dependency: the `helm` binary
 * must be installed on the deploying machine (`HELM_BIN` overrides the
 * binary path).
 */
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as YAML from "yaml";
import type { KubernetesObjectDefinition } from "./objects.ts";

/** A Helm invocation or render failure (bad chart ref, template error, …). */
export class HelmError extends Data.TaggedError("HelmError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const HelmBin = Config.string("HELM_BIN").pipe(
  Effect.orElseSucceed(() => "helm"),
);

export interface RenderHelmChartOptions {
  /**
   * Chart reference: a repository chart name (with `repo`), an
   * `oci://` reference, or a local chart directory path.
   */
  chart: string;
  /** Classic chart repository URL (`--repo`). */
  repo?: string | undefined;
  /** Chart version (`--version`). */
  version?: string | undefined;
  /** Release name the chart's templates render with (`.Release.Name`). */
  releaseName: string;
  /** Namespace the chart renders into (`.Release.Namespace`). */
  namespace: string;
  /** Values passed to the chart (written to a temp values file). */
  values?: Record<string, unknown> | undefined;
  /**
   * Render objects from the chart's `crds/` directory too
   * (`--include-crds`).
   * @default true
   */
  includeCrds?: boolean | undefined;
}

/**
 * Render a chart with `helm template` and parse the multi-document YAML
 * output into object definitions. Every rendered object must carry
 * `apiVersion`, `kind`, and `metadata.name` (server-side apply needs a
 * name; `generateName`-only objects are rejected with a clear error).
 */
export const renderHelmChart = Effect.fn(function* (
  options: RenderHelmChartOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bin = yield* HelmBin;

  const args = [
    "template",
    options.releaseName,
    options.chart,
    "--namespace",
    options.namespace,
  ];
  if (options.repo !== undefined) {
    args.push("--repo", options.repo);
  }
  if (options.version !== undefined) {
    args.push("--version", options.version);
  }
  if (options.includeCrds ?? true) {
    args.push("--include-crds");
  }
  if (options.values !== undefined && Object.keys(options.values).length > 0) {
    // JSON is valid YAML, so the literal values object round-trips through
    // a temp values file without a YAML serializer.
    const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-helm-" });
    const valuesFile = path.join(dir, "values.json");
    yield* fs.writeFileString(valuesFile, JSON.stringify(options.values));
    args.push("--values", valuesFile);
  }

  const result = yield* ChildProcess.make(bin, args, {
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
          stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
        },
        { concurrency: "unbounded" },
      ),
    ),
    // A spawn failure (almost always ENOENT) means the helm CLI itself is
    // missing — a machine-setup problem, not a resource error.
    Effect.catchCause((cause) =>
      Effect.die(
        new Error(
          `Failed to run '${bin}': ${String(cause)}. AWS.EKS.HelmChart renders charts with the local helm CLI — install it (https://helm.sh/docs/intro/install/) or point HELM_BIN at the binary.`,
        ),
      ),
    ),
  );

  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new HelmError({
        message:
          `helm ${args.join(" ")} exited with code ${String(result.exitCode)}: ` +
          result.stderr.trim(),
      }),
    );
  }

  return yield* parseRenderedManifests(options.chart, result.stdout);
});

/** Parse `helm template` output (multi-document YAML) into definitions. */
export const parseRenderedManifests = (
  chart: string,
  rendered: string,
): Effect.Effect<Array<KubernetesObjectDefinition>, HelmError> =>
  Effect.gen(function* () {
    const documents = yield* Effect.try({
      try: () => YAML.parseAllDocuments(rendered),
      catch: (cause) =>
        new HelmError({
          message: `Failed to parse rendered manifests from chart '${chart}'`,
          cause,
        }),
    });

    const objects: Array<KubernetesObjectDefinition> = [];
    for (const document of documents) {
      const value = document.toJS() as unknown;
      // helm renders empty documents for templates that produce no output
      // (conditionals, whitespace) — skip them.
      if (value === null || value === undefined) continue;
      if (typeof value !== "object" || Array.isArray(value)) {
        return yield* Effect.fail(
          new HelmError({
            message: `Chart '${chart}' rendered a non-object YAML document: ${JSON.stringify(value)}`,
          }),
        );
      }
      const object = value as Partial<KubernetesObjectDefinition>;
      if (
        typeof object.apiVersion !== "string" ||
        typeof object.kind !== "string"
      ) {
        return yield* Effect.fail(
          new HelmError({
            message: `Chart '${chart}' rendered an object without apiVersion/kind: ${JSON.stringify(value).slice(0, 200)}`,
          }),
        );
      }
      if (typeof object.metadata?.name !== "string") {
        return yield* Effect.fail(
          new HelmError({
            message: `Chart '${chart}' rendered a ${object.apiVersion}/${object.kind} without metadata.name — server-side apply requires a concrete name (generateName is not supported)`,
          }),
        );
      }
      objects.push(object as KubernetesObjectDefinition);
    }
    return objects;
  });
