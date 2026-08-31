import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { validateGeneratedBranchName } from "./GeneratedBranchName.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "generated-branch-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)(
  "validates full generated branch names without changing their spelling",
  (it) => {
    it.effect("accepts a valid mixed-case nested name", () =>
      Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "generated-branch-name-" });

        expect(yield* validateGeneratedBranchName(git, cwd, "  Theo/Fix.v2  ")).toBe("Theo/Fix.v2");
      }).pipe(Effect.scoped),
    );

    it.effect("rejects invalid and reserved names", () =>
      Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "generated-branch-name-" });

        expect(yield* validateGeneratedBranchName(git, cwd, "bad..name")).toBeNull();
        expect(yield* validateGeneratedBranchName(git, cwd, "bad\nname")).toBeNull();
        expect(yield* validateGeneratedBranchName(git, cwd, "HEAD")).toBeNull();
        expect(yield* validateGeneratedBranchName(git, cwd, "@{-1}")).toBeNull();
        expect(yield* validateGeneratedBranchName(git, cwd, "refs/heads/feature/demo")).toBeNull();
        expect(yield* validateGeneratedBranchName(git, cwd, "-dangerous")).toBeNull();
        expect(yield* validateGeneratedBranchName(git, cwd, "t3code/deadbeef")).toBeNull();
      }).pipe(Effect.scoped),
    );
  },
);
