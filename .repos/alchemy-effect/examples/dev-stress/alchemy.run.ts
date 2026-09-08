import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ApiFunction from "./src/ApiFunction.ts";
import EchoWorker from "./src/EchoWorker.ts";
import MicrovmWorker from "./src/MicrovmWorker.ts";
import { PORTS } from "./src/ports.ts";
import ShellImageLive from "./src/ShellImage.ts";
import Ec2Box from "./src/Ec2Box.ts";
import { SandboxLive } from "./src/SandboxContainer.ts";
import { STACK_NAME } from "./src/stack-config.ts";
// <<EXTRA_IMPORTS>>
// <</EXTRA_IMPORTS>>

/**
 * A deliberately cross-cloud `alchemy dev` stack, built to be REWRITTEN
 * while the dev server is running. `test/dev-stress.test.ts` copies this
 * project into a scratch directory, launches the real `alchemy dev` CLI
 * against the copy, and then edits, breaks, moves and churns these files
 * to prove the dev server neither dies nor goes stale.
 *
 * The regions marked `<<NAME>> … <</NAME>>` are patched by the suite; keep
 * them intact. See ./README.md for the layout.
 */
export default Alchemy.Stack(
  STACK_NAME,
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // ── AWS: Lambda + S3 + DynamoDB + SQS, all inside the floci emulator.
    // The whole subsystem lives in a region the stress suite deletes and
    // restores wholesale.
    // <<AWS_HALF>>
    const api = yield* ApiFunction;
    // <</AWS_HALF>>

    // ── Cloudflare: Effect-native Worker (source imported by this stack) ──
    const echo = yield* EchoWorker;

    // ── Cloudflare: path-`main` Worker (source NOT imported by this stack).
    // Its `AWS_LAMBDA_URL` var is the cross-cloud edge in the graph: a
    // change to the Lambda propagates into the Worker's bindings.
    const apiKv = yield* Cloudflare.KV.Namespace("ApiKV");
    const apiWorker = yield* Cloudflare.Worker("ApiWorker", {
      main: "./src/api-worker.ts",
      dev: { port: PORTS.api, strictPort: true },
      env: {
        KV: apiKv,
        // <<API_VARIABLE>>
        API_VARIABLE: "api-variable-v1",
        // <</API_VARIABLE>>
        // <<AWS_LAMBDA_URL>>
        AWS_LAMBDA_URL: api.functionUrl.as<string>(),
        // <</AWS_LAMBDA_URL>>
        // <<API_EXTRA_ENV>>
        // <</API_EXTRA_ENV>>
      },
    });

    // ── Cloudflare Website: build mode. Every re-apply re-runs build.sh
    // and republishes the assets through the local Worker simulator.
    const cfSite = yield* Cloudflare.Website.StaticSite("CfSite", {
      command: "bash build.sh",
      shell: true,
      cwd: "site/cf",
      outdir: "dist",
      main: "./site/cf/worker.ts",
      compatibility: { date: "2024-01-01" },
    });

    // ── AWS Website: dev-command mode. No AWS resources at all in dev —
    // just a `Command.Dev` child in the sidecar, restarted whenever its
    // resolved config changes.
    const awsSite = yield* AWS.Website.StaticSite("AwsSite", {
      path: "site/aws",
      dev: {
        command: "bun serve.mjs",
        cwd: "site/aws",
        env: {
          PORT: String(PORTS.awsSite),
          // <<SITE_MARKER>>
          SITE_MARKER: "aws-site-env-v1",
          // <</SITE_MARKER>>
        },
      },
    });

    // ── Cross-cloud headline: a Cloudflare Worker that mounts an AWS
    // Lambda MicroVM. Alchemy mints the IAM User + AccessKey + assume-role
    // Role for it; under `alchemy dev` all of it lands in floci.
    const microvmWorker = yield* MicrovmWorker;

    // ── AWS ECS: real docker containers under `alchemy dev` (floci runs
    // the tasks on the host daemon). Bridge networking publishes the
    // literal container port, so the suite probes fixed localhost ports.
    // Two services, two reload surfaces:
    //   - `EcsService` builds `site/ecs/` — its content, its Dockerfile,
    //     and its `env` prop are all mutated live by the stress suite;
    //   - `EcsInlineService`'s Dockerfile is INLINE — editing it is a pure
    //     prop change, which must roll the running containers too.
    const ecsCluster = yield* AWS.ECS.Cluster("StressEcsCluster");
    const ecsService = yield* AWS.ECS.Service("EcsService", {
      cluster: ecsCluster,
      context: "site/ecs",
      port: PORTS.ecs,
      cpu: 256,
      memory: 256,
      networkMode: "bridge",
      requiresCompatibilities: ["EC2"],
      launchType: "EC2",
      desiredCount: 1,
      runtimePlatform: {
        cpuArchitecture: process.arch === "arm64" ? "ARM64" : "X86_64",
        operatingSystemFamily: "LINUX",
      },
      deploymentStabilizationTimeout: "3 minutes",
      env: {
        // <<ECS_ENV>>
        STRESS_ENV: "ecs-env-v1",
        // <</ECS_ENV>>
      },
    });
    const ecsInlineService = yield* AWS.ECS.Service("EcsInlineService", {
      cluster: ecsCluster,
      dockerfile: {
        content: [
          "FROM busybox:stable",
          // <<ECS_INLINE_MARKER>>
          "RUN mkdir -p /www && echo -n ecs-inline-v1 > /www/index.html",
          // <</ECS_INLINE_MARKER>>
          `CMD ["httpd", "-f", "-p", "${PORTS.ecsInline}", "-h", "/www"]`,
        ].join("\n"),
      },
      port: PORTS.ecsInline,
      cpu: 256,
      memory: 256,
      networkMode: "bridge",
      requiresCompatibilities: ["EC2"],
      launchType: "EC2",
      desiredCount: 1,
      runtimePlatform: {
        cpuArchitecture: process.arch === "arm64" ? "ARM64" : "X86_64",
        operatingSystemFamily: "LINUX",
      },
      deploymentStabilizationTimeout: "3 minutes",
    });

    // ── AWS EC2: a hosted instance — the fourth floci compute unit. It
    // runs as a real container in the emulator; edits to its program go
    // through the ENGINE (re-plan → in-place bundle update → reboot), not
    // a sidecar hot swap.
    const ec2Box = yield* Ec2Box;

    // <<EXTRA>>
    // <</EXTRA>>

    return {
      // <<AWS_OUTPUTS>>
      apiUrl: api.functionUrl,
      // <</AWS_OUTPUTS>>
      echoUrl: echo.url,
      apiWorkerUrl: apiWorker.url,
      cfSiteUrl: cfSite.url,
      awsSiteUrl: awsSite.url,
      microvmUrl: microvmWorker.url,
      ecsServiceArn: ecsService.serviceArn,
      ecsInlineServiceArn: ecsInlineService.serviceArn,
      ec2Dns: ec2Box.publicDnsName,
      // <<EXTRA_OUTPUTS>>
      // <</EXTRA_OUTPUTS>>
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SandboxLive,
        ShellImageLive,
        // <<EXTRA_LAYERS>>
        // <</EXTRA_LAYERS>>
      ),
    ),
  ),
);
