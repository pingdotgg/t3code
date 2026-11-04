import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import { readCheckoutDetails } from "./checkoutDetails.ts";

it.live("reports the checked out revision, HEAD update time and exact origin/main divergence", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const git = yield* GitVcsDriver.GitVcsDriver;
    const run = (args: readonly string[]) =>
      git.execute({ cwd, operation: "checkout-details-test", args });
    yield* run(["init", "--initial-branch=main"]);
    yield* run(["config", "user.name", "Test"]);
    yield* run(["config", "user.email", "test@example.com"]);
    yield* run(["commit", "--allow-empty", "-m", "first"]);
    const first = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
    assert.isNull((yield* readCheckoutDetails(cwd))?.behindOriginMain);
    yield* run(["commit", "--allow-empty", "-m", "second"]);
    yield* run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    yield* run(["checkout", "--detach", first]);
    const details = yield* readCheckoutDetails(cwd);
    assert.strictEqual(details?.commit, first);
    assert.strictEqual(details?.behindOriginMain, 1);
    assert.isTrue(Number.isFinite(Date.parse(details?.committedAt ?? "")));
    assert.isTrue(Number.isFinite(Date.parse(details?.headUpdatedAt ?? "")));
    yield* run(["checkout", "main"]);
    assert.strictEqual((yield* readCheckoutDetails(cwd))?.behindOriginMain, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "checkout-details-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
