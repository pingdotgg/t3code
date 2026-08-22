import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeDevinCapabilitiesCacheKey,
  makeDevinContinuationGroupKey,
  makeDevinEnvironment,
  resolveDevinProfileLayout,
  resolveDevinUsageTranscriptPath,
} from "./DevinHome.ts";

it.layer(NodeServices.layer)("DevinHome", (it) => {
  describe("Devin profile resolution", () => {
    it.effect("uses the current CLI XDG profile when no override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve(NodeOS.homedir());
        const layout = yield* resolveDevinProfileLayout({ homePath: "" }, { HOME: home });

        expect(layout).toEqual({
          profileRootPath: undefined,
          configHomePath: path.join(home, ".config"),
          dataHomePath: path.join(home, ".local", "share"),
          cacheHomePath: path.join(home, ".cache"),
          configDirectoryPath: path.join(home, ".config", "devin"),
          dataDirectoryPath: path.join(home, ".local", "share", "devin"),
          cacheDirectoryPath: path.join(home, ".cache", "devin"),
        });
      }),
    );

    it.effect("honours inherited XDG paths for the current CLI profile", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = {
          HOME: "/users/devin",
          XDG_CONFIG_HOME: "/profiles/config",
          XDG_DATA_HOME: "/profiles/data",
          XDG_CACHE_HOME: "/profiles/cache",
          DEVIN_HOME: "/legacy/home",
        };
        const layout = yield* resolveDevinProfileLayout({ homePath: "" }, environment);

        expect(layout.configHomePath).toBe(path.resolve("/profiles/config"));
        expect(layout.dataHomePath).toBe(path.resolve("/profiles/data"));
        expect(layout.cacheHomePath).toBe(path.resolve("/profiles/cache"));
        expect(yield* makeDevinEnvironment({ homePath: "" }, environment)).toEqual(environment);
      }),
    );

    it.effect("maps an explicit profile to isolated XDG roots", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.devin-work";
        const root = path.resolve(NodeOS.homedir(), ".devin-work");

        const env = yield* makeDevinEnvironment(
          { homePath },
          {
            XDG_CONFIG_HOME: "/inherited/config",
            XDG_DATA_HOME: "/inherited/data",
            XDG_CACHE_HOME: "/inherited/cache",
          },
        );

        expect(env).toEqual({
          DEVIN_HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        });
        expect(yield* resolveDevinUsageTranscriptPath({ homePath }, env)).toBe(
          path.join(root, "data", "devin", "t3code-usage.jsonl"),
        );
      }),
    );

    it.effect("normalizes relative inherited XDG paths before spawning Devin", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* makeDevinEnvironment(
          { homePath: "" },
          {
            HOME: "/users/devin",
            XDG_CONFIG_HOME: "relative/config",
            XDG_DATA_HOME: "relative/data",
            XDG_CACHE_HOME: "relative/cache",
          },
        );

        expect(env.XDG_CONFIG_HOME).toBe(path.resolve("relative/config"));
        expect(env.XDG_DATA_HOME).toBe(path.resolve("relative/data"));
        expect(env.XDG_CACHE_HOME).toBe(path.resolve("relative/cache"));
      }),
    );

    it.effect("replaces blank XDG overrides that Devin would interpret as relative paths", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* makeDevinEnvironment(
          { homePath: "" },
          {
            HOME: "/users/devin",
            XDG_CONFIG_HOME: "",
            XDG_DATA_HOME: "",
            XDG_CACHE_HOME: "",
          },
        );

        expect(env.XDG_CONFIG_HOME).toBe(path.resolve("/users/devin/.config"));
        expect(env.XDG_DATA_HOME).toBe(path.resolve("/users/devin/.local/share"));
        expect(env.XDG_CACHE_HOME).toBe(path.resolve("/users/devin/.cache"));
      }),
    );

    it.effect("keys continuation and capabilities by the effective XDG profile", () =>
      Effect.gen(function* () {
        const first = {
          HOME: "/users/devin",
          XDG_CONFIG_HOME: "/profiles/config",
          XDG_DATA_HOME: "/profiles/data",
          XDG_CACHE_HOME: "/profiles/cache",
        };
        const same = { ...first };
        const other = { ...first, XDG_DATA_HOME: "/profiles/other-data" };

        const firstContinuation = yield* makeDevinContinuationGroupKey({ homePath: "" }, first);
        expect(yield* makeDevinContinuationGroupKey({ homePath: "" }, same)).toBe(
          firstContinuation,
        );
        expect(yield* makeDevinContinuationGroupKey({ homePath: "" }, other)).not.toBe(
          firstContinuation,
        );
        expect(
          yield* makeDevinContinuationGroupKey(
            { homePath: "", configPath: "/profiles/review.json", agentType: "review" },
            first,
          ),
        ).not.toBe(firstContinuation);
        expect(
          yield* makeDevinContinuationGroupKey(
            { homePath: "", configPath: "", agentType: "summarizer" },
            first,
          ),
        ).not.toBe(firstContinuation);

        expect(
          yield* makeDevinCapabilitiesCacheKey(
            { binaryPath: "devin", homePath: "" },
            "/work",
            first,
          ),
        ).toContain(
          `devin\0${first.XDG_CONFIG_HOME}\0${first.XDG_DATA_HOME}\0${first.XDG_CACHE_HOME}\0/work`,
        );
        expect(
          yield* makeDevinCapabilitiesCacheKey(
            {
              binaryPath: "devin",
              homePath: "",
              configPath: "/profiles/review.json",
              agentType: "review",
            },
            "/work",
            first,
          ),
        ).toContain("/profiles/review.json\0review");
      }),
    );
  });
});
