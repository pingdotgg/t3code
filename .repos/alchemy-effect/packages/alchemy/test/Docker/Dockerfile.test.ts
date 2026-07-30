import { imageSourceKind, validateImageSource } from "@/AWS/ECR/ImageSource.ts";
import {
  buildFinalDockerfile,
  containerEnvPreamble,
  validateContainerImageProps,
} from "@/Cloudflare/Containers/ContainerBundle.ts";
import * as Dockerfile from "@/Docker/Dockerfile.ts";
import * as Output from "@/Output.ts";
import { describe, expect, it, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

describe("Dockerfile.inline", () => {
  test("no interpolations produce plain string content", () => {
    const df = Dockerfile.inline`FROM oven/bun:1
RUN apt-get install -y ffmpeg`;
    expect(Dockerfile.isInlineDockerfile(df)).toBe(true);
    expect(typeof df.content).toBe("string");
    expect(df.content).toContain("FROM oven/bun:1");
    expect(df.content).toContain("RUN apt-get install -y ffmpeg");
  });

  test("content is deterministic across constructions", () => {
    const a = Dockerfile.inline`FROM oven/bun:1`;
    const b = Dockerfile.inline`FROM oven/bun:1`;
    expect(a.content).toBe(b.content);
  });

  test("interpolations produce Output content (dependency edge)", () => {
    const df = Dockerfile.inline`FROM ${Output.literal("oven/bun:1")}
RUN echo hi`;
    expect(Dockerfile.isInlineDockerfile(df)).toBe(true);
    expect(Output.isOutput(df.content)).toBe(true);
  });

  test("isInlineDockerfile rejects path strings", () => {
    expect(Dockerfile.isInlineDockerfile("./Dockerfile")).toBe(false);
    expect(Dockerfile.isInlineDockerfile(undefined)).toBe(false);
    expect(Dockerfile.isInlineDockerfile(null)).toBe(false);
  });
});

describe("AWS ImageSource composition", () => {
  test("main wins as the source kind; other fields describe its environment", () => {
    expect(imageSourceKind({ main: "./index.ts" })).toBe("main");
    expect(imageSourceKind({ main: "./index.ts", image: "oven/bun:1" })).toBe(
      "main",
    );
    expect(imageSourceKind({ image: "busybox:stable" })).toBe("image");
    expect(imageSourceKind({ context: "./app" })).toBe("context");
    expect(
      imageSourceKind({ dockerfile: Dockerfile.inline`FROM alpine` }),
    ).toBe("context");
    expect(imageSourceKind({})).toBeUndefined();
  });

  it.effect("validateImageSource dies on exclusivity violations", () =>
    Effect.gen(function* () {
      const dies = (source: Parameters<typeof validateImageSource>[1]) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            validateImageSource("T", source).pipe(
              Effect.catchDefect((defect) => Effect.fail(defect as Error)),
            ),
          );
          return Result.isFailure(result);
        });

      expect(
        yield* dies({ image: "busybox", dockerfile: "./Dockerfile" }),
      ).toBe(true);
      expect(yield* dies({ image: "busybox", context: "./app" })).toBe(true);
      expect(
        yield* dies({
          dockerfile: Dockerfile.inline`FROM alpine`,
          context: "./app",
        }),
      ).toBe(true);
      // Valid combinations pass.
      expect(yield* dies({ main: "./i.ts", image: "oven/bun:1" })).toBe(false);
      expect(
        yield* dies({ main: "./i.ts", dockerfile: Dockerfile.inline`FROM x` }),
      ).toBe(false);
      expect(
        yield* dies({ context: "./app", dockerfile: "./app/Dockerfile" }),
      ).toBe(false);
    }),
  );
});

/**
 * Run an Effect that may die and report whether it did — validation
 * helpers surface invalid props as defects (`Effect.die`), never typed
 * errors or raw throws.
 */
const dies = <A>(effect: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      effect.pipe(Effect.catchDefect((defect) => Effect.fail(defect as Error))),
    );
    return Result.isFailure(result);
  });

describe("Cloudflare container environment composition", () => {
  it.effect("containerEnvPreamble: image ref becomes FROM line", () =>
    Effect.gen(function* () {
      expect(yield* containerEnvPreamble({ image: "oven/bun:1" })).toBe(
        "FROM oven/bun:1",
      );
      expect(yield* containerEnvPreamble({})).toBeUndefined();
    }),
  );

  it.effect("containerEnvPreamble: inline content used verbatim", () =>
    Effect.gen(function* () {
      const preamble = yield* containerEnvPreamble({
        dockerfile: Dockerfile.inline`FROM oven/bun:1
RUN apt-get install -y ffmpeg`,
      });
      expect(preamble).toContain("RUN apt-get install -y ffmpeg");
    }),
  );

  it.effect(
    "containerEnvPreamble: dies on Dockerfile content passed as image",
    () =>
      Effect.gen(function* () {
        expect(
          yield* dies(
            containerEnvPreamble({ image: "FROM oven/bun:1\nRUN echo hi" }),
          ),
        ).toBe(true);
      }),
  );

  test("buildFinalDockerfile layers the bundle on top of the preamble", () => {
    const dockerfile = buildFinalDockerfile(
      "FROM oven/bun:1\nRUN apt-get install -y ffmpeg",
      "bun",
    );
    const lines = dockerfile.split("\n");
    expect(lines[0]).toBe("FROM oven/bun:1");
    expect(lines[1]).toBe("RUN apt-get install -y ffmpeg");
    expect(dockerfile).toContain("COPY index.mjs /app/index.mjs");
    expect(dockerfile).toContain('ENTRYPOINT ["bun", "/app/index.mjs"]');
  });

  test("buildFinalDockerfile falls back to the runtime default base", () => {
    expect(buildFinalDockerfile(undefined, "bun").split("\n")[0]).toBe(
      "FROM oven/bun:1",
    );
    expect(buildFinalDockerfile(undefined, "node").split("\n")[0]).toBe(
      "FROM node:22-slim",
    );
  });

  it.effect("validateContainerImageProps enforces exclusivity", () =>
    Effect.gen(function* () {
      // main + image and main + inline dockerfile are the two environments.
      expect(
        yield* dies(
          validateContainerImageProps({ main: "./i.ts", image: "oven/bun:1" }),
        ),
      ).toBe(false);
      expect(
        yield* dies(
          validateContainerImageProps({
            main: "./i.ts",
            dockerfile: Dockerfile.inline`FROM x`,
          }),
        ),
      ).toBe(false);
      expect(
        yield* dies(
          validateContainerImageProps({
            main: "./i.ts",
            image: "oven/bun:1",
            dockerfile: Dockerfile.inline`FROM x`,
          }),
        ),
      ).toBe(true);
      // A path dockerfile cannot be an environment on Cloudflare.
      expect(
        yield* dies(
          validateContainerImageProps({
            main: "./i.ts",
            dockerfile: "./Dockerfile",
          }),
        ),
      ).toBe(true);
      expect(
        yield* dies(
          validateContainerImageProps({ main: "./i.ts", context: "./app" }),
        ),
      ).toBe(true);
      // Without main: image is exclusive with dockerfile/context.
      expect(
        yield* dies(
          validateContainerImageProps({ image: "busybox", dockerfile: "./f" }),
        ),
      ).toBe(true);
      expect(
        yield* dies(
          validateContainerImageProps({ image: "busybox", context: "./app" }),
        ),
      ).toBe(true);
      // Inline content has no build context.
      expect(
        yield* dies(
          validateContainerImageProps({
            dockerfile: Dockerfile.inline`FROM x`,
            context: "./app",
          }),
        ),
      ).toBe(true);
      // The plain external build stays valid.
      expect(
        yield* dies(
          validateContainerImageProps({
            context: "./app",
            dockerfile: "./app/Dockerfile",
          }),
        ),
      ).toBe(false);
    }),
  );
});
