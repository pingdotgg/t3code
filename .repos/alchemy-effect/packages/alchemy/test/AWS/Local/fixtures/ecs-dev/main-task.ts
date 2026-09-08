import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Bundled-`main` fixture for the ECS local-dev conformance test: an inline
 * Effect program bundled into a bun-based image (exercising the full
 * bundle → generated Dockerfile → docker build → ECR push pipeline against
 * the floci-emulated registry), serving a marker over HTTP.
 *
 * `networkMode: "bridge"` + an explicit `port` makes floci publish the
 * literal host port on the Docker host, so the test can reach the container
 * at `localhost:<port>` (awsvpc tasks are expose-only when floci itself
 * runs in a container — no host binding to connect to from the test).
 */
export default class EcsDevMainTask extends AWS.ECS.Task<EcsDevMainTask>()(
  "EcsDevMainTask",
  {
    main: import.meta.filename,
    cpu: 256,
    memory: 512,
    port: 17357,
    networkMode: "bridge",
    requiresCompatibilities: ["EC2"],
    // Docker Hub's `oven/bun` image (also the default); the public.ecr.aws
    // mirrors rate-limit anonymous pulls during local builds.
    image: "oven/bun:1",
    // Build for the host architecture — the emulator runs the container on
    // this machine, so a cross-arch image would need qemu emulation.
    runtimePlatform:
      process.arch === "arm64"
        ? { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" }
        : { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ecs-dev-main-marker");
      }),
    };
  }),
) {}
