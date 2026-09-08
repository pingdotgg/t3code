import {
  decodeFunctionImageSource,
  functionImagePlatform,
  hashFunctionImageBuild,
  parseFunctionImageUri,
} from "@/AWS/Lambda/FunctionImage.ts";
import { validateFunctionPackageProps } from "@/AWS/Lambda/Function.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const describe = layer(NodeServices.layer);

describe("Lambda Function images", (it) => {
  it.effect("maps Lambda architectures to Docker platforms", () =>
    Effect.sync(() => {
      expect(functionImagePlatform("x86_64")).toBe("linux/amd64");
      expect(functionImagePlatform("arm64")).toBe("linux/arm64");
    }),
  );

  it.effect("parses tagged and digest-pinned private ECR image URIs", () =>
    Effect.gen(function* () {
      const tagged = yield* parseFunctionImageUri(
        "Tagged",
        "123456789012.dkr.ecr.eu-west-3.amazonaws.com/team/worker:release",
      );
      expect(tagged).toMatchObject({
        registryId: "123456789012",
        region: "eu-west-3",
        repositoryName: "team/worker",
        imageId: { imageTag: "release" },
      });

      const digest = `sha256:${"a".repeat(64)}`;
      const pinned = yield* parseFunctionImageUri(
        "Pinned",
        `123456789012.dkr.ecr.us-east-1.amazonaws.com/worker@${digest}`,
      );
      expect(pinned.imageId).toEqual({ imageDigest: digest });
      expect(pinned.repositoryUri).toBe(
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker",
      );
    }),
  );

  it.effect("rejects unsupported or incomplete ECR image URIs", () =>
    Effect.gen(function* () {
      const fips = yield* Effect.result(
        parseFunctionImageUri(
          "Fips",
          "123456789012.dkr.ecr-fips.us-east-1.amazonaws.com/worker:latest",
        ),
      );
      expect(Result.isFailure(fips)).toBe(true);
      if (Result.isFailure(fips)) {
        expect(fips.failure.message).toContain("do not support ECR FIPS");
      }

      const untagged = yield* Effect.result(
        parseFunctionImageUri(
          "Untagged",
          "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker",
        ),
      );
      expect(Result.isFailure(untagged)).toBe(true);
      if (Result.isFailure(untagged)) {
        expect(untagged.failure.message).toContain(
          "explicit ECR tag or digest",
        );
      }
    }),
  );

  it.effect("rejects mixed image sources and ZIP-only image options", () =>
    Effect.gen(function* () {
      const mixedSource = yield* Effect.result(
        decodeFunctionImageSource("MixedSource", {
          uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:latest",
          context: "./lambda",
          dockerfile: "Dockerfile",
        }),
      );
      expect(Result.isFailure(mixedSource)).toBe(true);
      if (Result.isFailure(mixedSource)) {
        expect(mixedSource.failure.message).toContain(
          "exactly one image source",
        );
      }

      const mixedPackage = yield* Effect.result(
        validateFunctionPackageProps("MixedPackage", {
          image: { uri: "example" },
          main: "./handler.ts",
          runtime: "nodejs22.x",
          layers: ["arn:aws:lambda:us-east-1:123456789012:layer:example:1"],
        }),
      );
      expect(Result.isFailure(mixedPackage)).toBe(true);
      if (Result.isFailure(mixedPackage)) {
        expect(mixedPackage.failure.message).toContain("main, runtime, layers");
      }
    }),
  );

  it.effect("does not hash files excluded by .dockerignore", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-hash-",
      });
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\nCOPY . /app\n",
      );
      yield* fs.makeDirectory(path.join(context, "ignored"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(context, ".dockerignore"),
        "ignored/**\n!ignored/included.txt\n",
      );
      yield* fs.writeFileString(
        path.join(context, "ignored", "excluded.txt"),
        "one",
      );
      yield* fs.writeFileString(
        path.join(context, "ignored", "included.txt"),
        "one",
      );

      const source = { context, dockerfile: "Dockerfile" };
      const initial = yield* hashFunctionImageBuild(source, "x86_64");
      yield* fs.writeFileString(
        path.join(context, "ignored", "excluded.txt"),
        "two",
      );
      expect(yield* hashFunctionImageBuild(source, "x86_64")).toBe(initial);

      yield* fs.writeFileString(
        path.join(context, "ignored", "included.txt"),
        "two",
      );
      expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(initial);
    }),
  );

  it.effect("preserves escaped Docker ignore wildcards", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-ignore-escape-",
      });
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\nCOPY . /app\n",
      );
      yield* fs.writeFileString(
        path.join(context, ".dockerignore"),
        "file\\?.txt\n",
      );
      yield* fs.writeFileString(path.join(context, "file?.txt"), "one");
      yield* fs.makeDirectory(path.join(context, "file"));
      yield* fs.writeFileString(path.join(context, "file", "a.txt"), "one");

      const source = { context, dockerfile: "Dockerfile" };
      const initial = yield* hashFunctionImageBuild(source, "x86_64");
      yield* fs.writeFileString(path.join(context, "file?.txt"), "two");
      expect(yield* hashFunctionImageBuild(source, "x86_64")).toBe(initial);

      yield* fs.writeFileString(path.join(context, "file", "a.txt"), "two");
      expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(initial);
    }),
  );

  it.effect(
    "hashes Dockerfile, build args, architecture, and relative context contents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-lambda-image-inputs-",
        });
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        yield* fs.makeDirectory(first, { recursive: true });
        yield* fs.makeDirectory(second, { recursive: true });

        for (const context of [first, second]) {
          yield* fs.writeFileString(
            path.join(context, "Dockerfile"),
            "FROM scratch\nCOPY app.txt /app.txt\n",
          );
          yield* fs.writeFileString(path.join(context, "app.txt"), "hello");
        }

        const source = {
          context: first,
          dockerfile: "Dockerfile",
          buildArgs: { B: "two", A: "one" },
        };
        const initial = yield* hashFunctionImageBuild(source, "x86_64");
        expect(
          yield* hashFunctionImageBuild(
            {
              context: second,
              dockerfile: "Dockerfile",
              buildArgs: { A: "one", B: "two" },
            },
            "x86_64",
          ),
        ).toBe(initial);
        expect(
          yield* hashFunctionImageBuild(
            {
              ...source,
              buildArgs: { A: "changed", B: "two" },
            },
            "x86_64",
          ),
        ).not.toBe(initial);
        expect(yield* hashFunctionImageBuild(source, "arm64")).not.toBe(
          initial,
        );

        yield* fs.writeFileString(
          path.join(first, "Dockerfile"),
          "FROM scratch\nCOPY app.txt /renamed.txt\n",
        );
        expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(
          initial,
        );
      }),
  );

  it.effect("hashes copied filesystem metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-metadata-",
      });
      const bootstrap = path.join(context, "bootstrap");
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\nCOPY . /app\n",
      );
      yield* fs.writeFileString(bootstrap, "#!/bin/sh\n");
      yield* fs.chmod(bootstrap, 0o644);

      const source = { context, dockerfile: "Dockerfile" };
      const initial = yield* hashFunctionImageBuild(source, "x86_64");

      yield* fs.chmod(bootstrap, 0o755);
      const executable = yield* hashFunctionImageBuild(source, "x86_64");
      expect(executable).not.toBe(initial);

      yield* fs.makeDirectory(path.join(context, "empty"));
      expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(
        executable,
      );
    }),
  );

  it.effect("hashes symbolic link targets without following them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-symlink-",
      });
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\nCOPY . /app\n",
      );
      yield* fs.writeFileString(path.join(context, "target-a"), "same");
      yield* fs.writeFileString(path.join(context, "target-b"), "same");
      const link = path.join(context, "current");
      yield* fs.symlink("target-a", link);

      const source = { context, dockerfile: "Dockerfile" };
      const initial = yield* hashFunctionImageBuild(source, "x86_64");

      yield* fs.remove(link);
      yield* fs.symlink("target-b", link);
      expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(initial);
    }),
  );

  it.effect(
    "uses a Dockerfile-specific ignore file instead of the context root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const context = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-lambda-image-ignore-",
        });
        yield* fs.writeFileString(
          path.join(context, "Lambda.Dockerfile"),
          "FROM scratch\nCOPY . /app\n",
        );
        yield* fs.writeFileString(
          path.join(context, ".dockerignore"),
          "root-only.txt\n",
        );
        yield* fs.writeFileString(
          path.join(context, "Lambda.Dockerfile.dockerignore"),
          "specific-only.txt\n",
        );
        yield* fs.writeFileString(
          path.join(context, "specific-only.txt"),
          "one",
        );
        yield* fs.writeFileString(path.join(context, "root-only.txt"), "one");

        const source = { context, dockerfile: "Lambda.Dockerfile" };
        const initial = yield* hashFunctionImageBuild(source, "x86_64");
        yield* fs.writeFileString(
          path.join(context, "specific-only.txt"),
          "two",
        );
        expect(yield* hashFunctionImageBuild(source, "x86_64")).toBe(initial);

        yield* fs.writeFileString(path.join(context, "root-only.txt"), "two");
        expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(
          initial,
        );
      }),
  );

  it.effect(
    "does not alias an external Docker ignore file into the context",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-lambda-image-external-ignore-",
        });
        const context = path.join(root, "context");
        const dockerfile = path.join(root, "Lambda.Dockerfile");
        yield* fs.makeDirectory(context);
        yield* fs.writeFileString(dockerfile, "FROM scratch\nCOPY . /app\n");
        yield* fs.writeFileString(
          `${dockerfile}.dockerignore`,
          "ignored.txt\n",
        );
        yield* fs.writeFileString(path.join(context, "ignored.txt"), "one");
        yield* fs.writeFileString(
          path.join(context, "Lambda.Dockerfile.dockerignore"),
          "one",
        );

        const source = { context, dockerfile };
        const initial = yield* hashFunctionImageBuild(source, "x86_64");
        yield* fs.writeFileString(path.join(context, "ignored.txt"), "two");
        expect(yield* hashFunctionImageBuild(source, "x86_64")).toBe(initial);

        yield* fs.writeFileString(
          path.join(context, "Lambda.Dockerfile.dockerignore"),
          "two",
        );
        expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(
          initial,
        );
      }),
  );

  it.effect("requires an explicit Dockerfile for local image sources", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-schema-",
      });
      const result = yield* Effect.result(
        decodeFunctionImageSource("MissingDockerfile", { context }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
