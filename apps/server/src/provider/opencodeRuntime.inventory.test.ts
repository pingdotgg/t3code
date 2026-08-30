import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("OpenCodeRuntime inventory", (it) => {
  it.effect("keeps provider inventory when skill discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.reject(new Error("skills endpoint unavailable")),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps only SDK skill metadata in inventory", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () =>
            Promise.resolve({
              data: [
                {
                  name: "review",
                  description: "Review code changes",
                  location: "/skills/review/SKILL.md",
                  content: "unused skill content",
                },
              ],
            }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.skills, [
        {
          name: "review",
          description: "Review code changes",
          location: "/skills/review/SKILL.md",
        },
      ]);
    }),
  );

  it.effect("drops oversized CLI skill output without losing the model inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const executablePath = yield* HostProcessExecutablePath;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-inventory-" });
      const isWindows = hostPlatform === "win32";
      const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
      const scriptPath = path.join(tempDir, "opencode.mjs");
      const oversizedContentBytes = 8 * 1024 * 1024 + 1;

      yield* fs.writeFileString(
        scriptPath,
        [
          'if (process.argv[2] === "models") {',
          '  process.stdout.write(`openai/gpt-test\\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\\n`);',
          '} else if (process.argv[2] === "debug") {',
          `  const content = "x".repeat(${oversizedContentBytes});`,
          '  process.stdout.write(`[{"name":"oversized","content":"${content}"}]`);',
          "}",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        binaryPath,
        [
          ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
          isWindows
            ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
            : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
          "",
        ].join("\n"),
      );
      if (!isWindows) {
        yield* fs.chmod(binaryPath, 0o755);
      }

      const runtime = yield* OpenCodeRuntime;
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        cwd: tempDir,
        environment: {
          ...hostEnvironment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: scriptPath,
        },
      });

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.equal(inventory.skills.length, 0);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );
});
