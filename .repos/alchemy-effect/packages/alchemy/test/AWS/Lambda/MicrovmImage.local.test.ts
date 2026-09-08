/**
 * `AWS.Lambda.MicrovmImage` under `alchemy dev`: the dev provider builds the
 * image with a plain HOST-side `docker build` (BuildKit layer cache against
 * the user's real sources) and hands the emulator a pre-built
 * `docker://<tag>` artifact, which the alchemy floci fork runs as-is —
 * nothing is zipped, uploaded, or built inside the emulator.
 *
 * Proof structure:
 *   - deploy an effectful image: attrs carry the dummy account AND a
 *     `docker://alchemy-dev/microvm-…` artifact uri — the live cloud can
 *     never mint either, and the uri is proof the host-build path ran;
 *   - `RunMicrovm` out-of-band reaches RUNNING — the emulator actually
 *     BOOTED a VM from the host-built reference (an invalid or unbuilt ref
 *     fails the run);
 *   - re-deploy with NO change: a true noop (dev diff policy — content is
 *     the watch loop's job, and nothing changed);
 *   - rewrite the program's marker in the clone WITHOUT a deploy: the
 *     sidecar watch loop rebuilds (docker layer cache — only the COPY layer
 *     re-runs) and re-reconciles; the emulator's `latestActiveImageVersion`
 *     advances within seconds, and a fresh `RunMicrovm` boots the new
 *     version;
 *   - destroy removes the image from the emulator.
 *
 * Requires Docker (floci runs as a container, MicroVMs run as containers);
 * skipped when the daemon is unavailable.
 */
import * as AWS from "@/AWS";
import * as Endpoint from "@/AWS/Endpoint.ts";
import * as Region from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { dockerAvailable, FLOCI_ENDPOINT } from "../Local/fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = fileURLToPath(
  new URL("./fixtures/microvm-dev", import.meta.url),
);

/** Floci-scoped context for the raw distilled calls the test makes itself. */
const flociContext = Layer.mergeAll(
  Endpoint.of(FLOCI_ENDPOINT),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

/** Boot a VM from the image and prove it reaches RUNNING, then clean up. */
const bootsToRunning = (imageArn: string, imageVersion?: string) =>
  Effect.gen(function* () {
    const vm = yield* microvms.runMicrovm({
      imageIdentifier: imageArn,
      ...(imageVersion !== undefined ? { imageVersion } : {}),
    });
    const state = yield* microvms
      .getMicrovm({ microvmIdentifier: vm.microvmId })
      .pipe(
        Effect.map((m) => m.state),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (s): boolean => s !== "PENDING",
          times: 60,
        }),
        Effect.ensuring(
          microvms
            .terminateMicrovm({ microvmIdentifier: vm.microvmId })
            .pipe(Effect.ignore),
        ),
      );
    return { state, imageVersion: vm.imageVersion };
  }).pipe(Effect.provide(flociContext));

test.provider.skipIf(!dockerAvailable)(
  "dev builds the image host-side (docker://), boots it, and a content edit hot-rebuilds it within seconds",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const clone = yield* cloneFixture(fixtureDir, {
        prefix: "floci-dev-microvm-",
      });
      const mainPath = path.join(clone, "program.ts");

      const declaration = Effect.gen(function* () {
        const buildRole = yield* AWS.IAM.Role("DevMicrovmBuildRole");
        return yield* AWS.Lambda.MicrovmImage("DevMicrovm", {
          main: mainPath,
          buildRole,
          runtime: "bun",
          resources: [{ minimumMemoryInMiB: 512 }],
          cpuConfigurations: [{ architecture: "ARM_64" }],
        });
      });

      const first = yield* stack.deploy(declaration);
      // Emulator identity: the live cloud never mints the dummy account.
      expect(first.imageArn).toContain(":000000000000:");
      // The host-build path: a pre-built local docker reference, not an
      // uploaded-zip S3 uri.
      expect(first.codeArtifact?.uri).toMatch(
        /^docker:\/\/alchemy-dev\/microvm-/,
      );
      expect(first.codeArtifact?.hash).toBeDefined();
      const v1 = first.latestActiveImageVersion;
      expect(v1).toBeDefined();

      // The emulator can BOOT the host-built reference: RunMicrovm reaches
      // RUNNING (a missing or broken image ref fails the run).
      const booted = yield* bootsToRunning(first.imageArn);
      expect(booted.state).toBe("RUNNING");
      expect(booted.imageVersion).toBe(v1);

      // Same declaration, same source — a true noop: nothing is rebuilt.
      const unchanged = yield* stack.deploy(declaration);
      expect(unchanged.codeArtifact?.hash).toBe(first.codeArtifact!.hash);
      expect(unchanged.latestActiveImageVersion).toBe(v1);

      // Content-only edit, NO deploy: the sidecar watch loop rebuilds
      // (cached docker build) and re-reconciles; the emulator's active
      // version advances. This is the latency the whole design exists for.
      const source = yield* fs.readFileString(mainPath);
      const editStartedAt = Date.now();
      yield* fs.writeFileString(
        mainPath,
        source.replace(`"microvm-marker-v1"`, `"microvm-marker-v2"`),
      );
      const rebuilt = yield* microvms
        .getMicrovmImage({ imageIdentifier: first.imageArn })
        .pipe(
          Effect.provide(flociContext),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (image): boolean =>
              image.latestActiveImageVersion !== undefined &&
              image.latestActiveImageVersion !== v1,
            times: 120,
          }),
        );
      const rebuildMs = Date.now() - editStartedAt;
      // eslint-disable-next-line no-console
      console.log(
        `microvm content edit -> new active version in ${rebuildMs}ms`,
      );
      expect(rebuilt.latestActiveImageVersion).not.toBe(v1);
      // The point of the docker:// path: a content edit is a cached docker
      // build, not a zip-upload-extract-rebuild. Well under a minute even
      // on a cold-ish daemon; typically a few seconds.
      expect(rebuildMs).toBeLessThan(30_000);

      // A fresh VM boots the NEW active version.
      const rebooted = yield* bootsToRunning(first.imageArn);
      expect(rebooted.state).toBe("RUNNING");
      expect(rebooted.imageVersion).toBe(rebuilt.latestActiveImageVersion);

      // Destroy: the image must be gone from the emulator.
      yield* stack.destroy();
      const gone = yield* microvms
        .getMicrovmImage({ imageIdentifier: first.imageArn })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
          Effect.provide(flociContext),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (isGone): boolean => isGone,
            times: 20,
          }),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 600_000 },
);
