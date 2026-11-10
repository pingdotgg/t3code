import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { findEasProjectId } from "./easProjectId.ts";

const ID_A = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const ID_B = "54d70eaf-b0a3-477a-a9cd-2cf81a5c84c9";

const workspace = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-eas-project-" });
    for (const [file, content] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
      yield* fs.writeFileString(path.join(root, file), content);
    }
    return root;
  });

const layer = NodeServices.layer;

it.effect("reads a literal project id from an app config without running it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* workspace({});
    const marker = path.join(root, "config-ran");
    yield* fs.makeDirectory(path.join(root, "apps/mobile"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "apps/mobile/app.config.ts"),
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "");
      export default { extra: { eas: { projectId: "${ID_A}" } } };`,
    );
    expect(yield* findEasProjectId(root)).toEqual(Option.some(ID_A));
    expect(yield* fs.exists(marker)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("falls back to app.json, and does not compute a project id a config builds", () =>
  Effect.gen(function* () {
    const staticOnly = yield* workspace({
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    expect(yield* findEasProjectId(staticOnly)).toEqual(Option.some(ID_B));
    const computed = yield* workspace({
      "app.config.ts": `const parts = ${JSON.stringify(ID_A.split("-"))};
        export default { extra: { eas: { projectId: parts.join("-") } } };`,
    });
    expect(yield* findEasProjectId(computed)).toEqual(Option.none());
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  {
    case: "reads the one project id a config names, whatever else it holds",
    files: {
      "app.config.js": `export default {
        assetBundlePatterns: ["**/*"],
        extra: { eas: { projectId: "${ID_A}" }, firebase: { projectId: "my-app-12345" } },
      };
      /** docs */`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.some(ID_A),
  },
  {
    case: "gives no answer when a config names a project only some builds use",
    files: {
      "app.config.ts": `export default ({ config }) =>
        process.env.APP_VARIANT === "preview"
          ? { ...config, extra: { ...config.extra, eas: { projectId: "${ID_B}" } } }
          : config;`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a comment keeps an old project id",
    files: {
      "app.config.js": `// projectId: "${ID_B}" (the old production project)
        export default { extra: { eas: { projectId: "${ID_A}" } } };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when one app sets its project from a variable",
    files: {
      "apps/mobile/app.config.ts": `export default {
        extra: { eas: { projectId: process.env.EAS_PROJECT_ID } },
      };`,
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config changes the project id after naming it",
    files: {
      "app.config.js": `export default ({ config }) => {
        config.extra = { eas: { projectId: "${ID_A}" } };
        if (process.env.APP_ENV === "development") {
          config.extra.eas.projectId = process.env.DEV_PROJECT_ID;
        }
        return config;
      };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a spread after the project id may replace it",
    files: {
      "apps/mobile/app.config.js": `import { eas } from "./app.shared.js";
        export default { extra: { eas: { projectId: "${ID_A}", ...eas } } };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when the config is assigned over after naming the project id",
    files: {
      "app.config.js": `export default ({ config }) => {
        config.extra = { eas: { projectId: "${ID_A}" } };
        Object.assign(config.extra.eas, JSON.parse(process.env.EAS_OVERRIDES ?? "{}"));
        return config;
      };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config spreads another file over app.json's project id",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, ...require("./app.local.js") });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a dynamic config spreads nothing, which may or may not use app.json",
    files: {
      "app.config.js": `export default { name: "Mobile", slug: "mobile" };`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config has more extra entries than are read",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, extra: { ...config.extra, ${"extra: { ...config.extra, ".repeat(40)}${"}".repeat(40)} } });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "reads app.json's id through extra and eas entries that spread their own",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({
        ...config,
        extra: { ...config?.["extra"], eas: { ...config.extra?.eas, build: { experimental: true } }, other: 1 },
      });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.some(ID_A),
  },
  {
    case: "reads a project id that follows spreads",
    files: {
      "app.config.js": `export default ({ config }) => ({
        ...config,
        extra: { ...config.extra, eas: { ...(config.extra?.eas ?? {}), projectId: "${ID_A}" } },
      });`,
    },
    expected: Option.some(ID_A),
  },
  {
    case: "gives no answer when an app.json Expo reads as JSON5 cannot be decoded here",
    files: {
      "apps/mobile/app.json": `{
        // the mobile app
        "expo": { "extra": { "eas": { "projectId": "${ID_B}" } }, },
      }`,
      "apps/admin/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "reads only the first static config, like Expo",
    files: {
      "app.config.json": JSON.stringify({ expo: { name: "Mobile" } }),
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "does not guess between an unwrapped static config and a wrapped one",
    files: {
      "apps/mobile/app.config.json": JSON.stringify({ extra: { eas: { projectId: ID_A } } }),
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "uses app.json when the config never mentions a project id",
    files: {
      "app.config.js": `export default ({ config }) => ({ ...config, name: "Mobile" });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.some(ID_B),
  },
])("$case", ({ files, expected }) =>
  Effect.gen(function* () {
    expect(yield* findEasProjectId(yield* workspace(files))).toEqual(expected);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "gives no answer when a comment ending in a non-LF line terminator precedes the rest of a joined id",
  () =>
    Effect.gen(function* () {
      // A line comment ends at any ECMAScript line terminator, not only LF.
      const root = yield* workspace({
        "apps/mobile/app.config.ts":
          `export default { extra: { eas: { projectId: "${ID_A.slice(0, 9)}" // prefix\u2028` +
          `+ "${ID_A.slice(9)}" } } };`,
        "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
      });
      expect(yield* findEasProjectId(root)).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("gives no answer when an app's config is there but cannot be read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const file of ["app.json", "app.config.json"]) {
      const root = yield* workspace({
        "apps/two/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
      });
      // A directory where the file should be: it exists but cannot be read.
      yield* fs.makeDirectory(path.join(root, "apps/one", file), { recursive: true });
      expect(yield* findEasProjectId(root)).toEqual(Option.none());
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("does not guess between apps that name different EAS projects", () =>
  Effect.gen(function* () {
    const root = yield* workspace({
      "apps/one/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
      "apps/two/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    expect(yield* findEasProjectId(root)).toEqual(Option.none());
    expect(yield* findEasProjectId(yield* workspace({ "README.md": "no app" }))).toEqual(
      Option.none(),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
