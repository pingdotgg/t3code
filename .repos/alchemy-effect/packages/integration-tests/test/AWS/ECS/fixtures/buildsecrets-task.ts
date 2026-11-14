import { Task } from "@alchemy.run/aws/ECS/Task";
import * as Redacted from "effect/Redacted";

/** 26 characters: `buildsecrets/Dockerfile` checks for "hello 26". */
export const BUILD_SECRET = "alchemy-build-secret-value";

/**
 * A one-shot `AWS.ECS.Task` built from `buildsecrets/Dockerfile` with a
 * build arg and a BuildKit secret. Its command exits 0 only when the build
 * saw both.
 */
export default Task("EcsBuildSecretsTask", {
  context: `${import.meta.dirname}/buildsecrets`,
  build: {
    args: { GREETING: "hello" },
    secrets: { token: Redacted.make(BUILD_SECRET) },
  },
  cpu: 256,
  memory: 512,
  // Build/run on ARM64 so an image built on an Apple Silicon host matches
  // the Fargate runtime architecture (Graviton).
  runtimePlatform: {
    cpuArchitecture: "ARM64",
    operatingSystemFamily: "LINUX",
  },
});
