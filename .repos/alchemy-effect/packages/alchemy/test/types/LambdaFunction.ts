import type {
  DurableFunctionProps,
  FunctionImageProps,
  FunctionProps,
} from "@/AWS/Lambda/index.ts";
import {
  DurableFunction as DurableFn,
  Function as LambdaFunction,
} from "@/AWS/Lambda/index.ts";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;

export type _ZipFunctionAccepted = Assert<
  { main: "./handler.ts" } extends FunctionProps ? true : false
>;

export type _ImageFunctionAccepted = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
  } extends FunctionProps
    ? true
    : false
>;

export type _EcrImageFunctionAccepted = Assert<
  {
    image: {
      uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:latest";
      command: ["index.handler"];
      entryPoint: ["/lambda-entrypoint.sh"];
      workingDirectory: "/var/task";
    };
    architecture: "x86_64";
  } extends FunctionProps
    ? true
    : false
>;

export type _MixedImageSourcesRejected = Assert<
  {
    image: {
      uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:latest";
      context: "./lambda";
      dockerfile: "Dockerfile";
    };
    architecture: "x86_64";
  } extends FunctionProps
    ? false
    : true
>;

export type _ImageDockerfileRequired = Assert<
  {
    image: { context: "./lambda" };
    architecture: "x86_64";
  } extends FunctionProps
    ? false
    : true
>;

export type _ImageArchitectureRequired = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
  } extends FunctionProps
    ? false
    : true
>;

export type _MixedPackageRejected = Assert<
  {
    main: "./handler.ts";
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
  } extends FunctionProps
    ? false
    : true
>;

export type _ImageRuntimeOptionsRejected = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
    runtime: "nodejs22.x";
  } extends FunctionProps
    ? false
    : true
>;

export type _ZipLayersAccepted = Assert<
  {
    main: "./handler.ts";
    layers: ["arn:aws:lambda:us-east-1:123456789012:layer:example:1"];
  } extends FunctionProps
    ? true
    : false
>;

export type _ImageLayersRejected = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
    layers: ["arn:aws:lambda:us-east-1:123456789012:layer:example:1"];
  } extends FunctionProps
    ? false
    : true
>;

export type _PackageTypeIsDerived = Assert<
  "packageType" extends keyof FunctionProps ? false : true
>;

// Durability is orthogonal to packaging: both a bundled and an image
// durable function are representable.
export type _DurableZipAccepted = Assert<
  {
    main: "./orchestrator.ts";
    executionTimeout: "1 hour";
  } extends DurableFunctionProps
    ? true
    : false
>;

// A prebuilt image has no `main` for the orchestrator's `impl` Effect to be
// bundled into, so it is not durable-capable. (Packaging is NOT the reason:
// props are selected by shape, so any main-bearing variant qualifies.)
export type _DurablePrebuiltImageRejected = Assert<
  {
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
    retentionPeriod: "7 days";
  } extends DurableFunctionProps
    ? false
    : true
>;

// The distribution preserves every main-bearing prop: a durable function
// still accepts the full bundled surface (runtime, layers, build, …).
export type _DurableKeepsZipProps = Assert<
  {
    main: "./orchestrator.ts";
    runtime: "nodejs24.x";
    layers: [];
    build: { install: ["sharp"] };
  } extends DurableFunctionProps
    ? true
    : false
>;

// The `Omit` distributes, so each variant keeps its own shape: a durable
// function still cannot be neither, both, or missing its entrypoint.
export type _DurableEmptyRejected = Assert<
  { executionTimeout: "1 hour" } extends DurableFunctionProps ? false : true
>;

export type _DurableMixedPackageRejected = Assert<
  {
    main: "./orchestrator.ts";
    image: { context: "./lambda"; dockerfile: "Dockerfile" };
    architecture: "x86_64";
  } extends DurableFunctionProps
    ? false
    : true
>;

LambdaFunction("zip-inline-accepted", { main: "./handler.ts" }, Effect.void);

const durableImpl = Effect.succeed({
  run: () => Effect.void,
}) as Effect.Effect<any>;

class DurableZip extends DurableFn<DurableZip>()(
  "durable-zip-accepted",
  { main: "./orchestrator.ts", executionTimeout: "1 hour" },
  durableImpl,
) {}

class DurableNoUrl extends DurableFn<DurableNoUrl>()(
  "durable-url-rejected",
  // @ts-expect-error Durable invocations arrive as the durable envelope, so
  // a durable function has no HTTP surface.
  { main: "./orchestrator.ts", functionUrl: true },
  durableImpl,
) {}

export type { DurableZip, DurableNoUrl };

const imageProps: FunctionImageProps = {
  image: { context: "./lambda", dockerfile: "Dockerfile" },
  architecture: "x86_64",
};

// @ts-expect-error Image functions use the Dockerfile's handler.
LambdaFunction("image-inline-rejected", imageProps, Effect.void);
