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
    case: "gives no answer for a config naming two projects, even with app.json",
    files: {
      "app.config.js": `export default () => ({
        extra: { eas: { projectId: process.env.PROD ? "${ID_A}" : "${ID_B}" } },
      });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
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
    case: "gives no answer when a comment's id sits beside a computed one",
    files: {
      "app.config.ts": `// projectId: "${ID_A}"
        export default { extra: { eas: { projectId: process.env.EAS_PROJECT_ID } } };`,
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
    case: "uses app.json when the config only mentions a longer identifier",
    files: {
      "app.config.js": `const easProjectIds = {};
        export default ({ config }) => ({ ...config, name: "Mobile", easProjectIds });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.some(ID_B),
  },
  {
    case: "gives no answer when a longer quoted key sits beside a computed project id",
    files: {
      "app.config.js": `const defaults = { easProjectId: "${ID_B}" };
        export default { extra: { eas: { projectId: process.env.EAS_PROJECT_ID ?? defaults.easProjectId } } };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config joins the project id from pieces",
    files: {
      "apps/mobile/app.config.ts": `export default {
        extra: { eas: { projectId: "${ID_A.slice(0, 9)}" + "${ID_A.slice(9)}" } },
      };`,
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config joins the project id around a comment",
    files: {
      "apps/mobile/app.config.ts": `export default {
        extra: { eas: { projectId: "${ID_A.slice(0, 9)}" /* prefix */ + "${ID_A.slice(9)}" } },
      };`,
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "reads a project id a comment follows",
    files: {
      "app.config.ts": `export default {
        extra: { eas: { projectId: "${ID_A}" /* production */ // the only one
        } },
      };`,
    },
    expected: Option.some(ID_A),
  },
  {
    case: "gives no answer when a separator inside a comment precedes the rest of the id",
    files: {
      "apps/mobile/app.config.ts": `export default {
        extra: { eas: { projectId: "${ID_A.slice(0, 9)}" // prefix, continued (below)
          + "${ID_A.slice(9)}" } },
      };`,
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a block comment with a separator precedes the rest of the id",
    files: {
      "apps/mobile/app.config.ts": `export default {
        extra: { eas: { projectId: "${ID_A.slice(0, 9)}" /* prefix, (see) */ + "${ID_A.slice(9)}" } },
      };`,
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
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
    case: "gives no answer when a spread after the project id hides behind a comment",
    files: {
      "apps/mobile/app.config.js": `import { easOverrides } from "./app.shared.js";
        export default { extra: { eas: { projectId: "${ID_A}" /* } */, ...easOverrides } } };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a spread at the top of the config may replace the project id",
    files: {
      "apps/mobile/app.config.js": `import { brand } from "./app.shared.js";
        export default { extra: { eas: { projectId: "${ID_A}" } }, ...brand };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a spread in an enclosing object may replace the project id",
    files: {
      "apps/mobile/app.config.js": `import { extraOverrides } from "./app.shared.js";
        export default { extra: { eas: { projectId: "${ID_A}" }, ...extraOverrides } };`,
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
    case: "gives no answer when the config is assigned over across lines after naming the project id",
    files: {
      "app.config.js": `import { assign } from "lodash";
        export default ({ config }) => {
        config.extra = { eas: { projectId: "${ID_A}" } };
        Object
          .assign(config.extra.eas, JSON.parse(process.env.EAS_OVERRIDES ?? "{}"));
        return config;
      };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a helper assigns over the config after naming the project id",
    files: {
      "app.config.js": `import { assign } from "lodash";
        export default ({ config }) => {
        config.extra = { eas: { projectId: "${ID_A}" } };
        assign (config.extra.eas, JSON.parse(process.env.EAS_OVERRIDES ?? "{}"));
        return config;
      };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when the config is assigned over from defaults that name the project id",
    files: {
      "app.config.js": `module.exports = Object.assign(
        { name: "Mobile", extra: { eas: { projectId: "${ID_A}" } } },
        require("./app.config.local.js"),
      );`,
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
    case: "gives no answer when a comment or parentheses sit between a spread and another file",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({
        ...config,
        .../* environment overrides */ require("./app.local.js"),
      });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when nested parentheses sit between a spread and another file",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, ...((require("./app.local.js"))) });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when another service's project id sits beside a spread over app.json's",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({
        ...config,
        ...require("./app.local.js"),
        web: { config: { firebase: { projectId: "my-firebase-app" } } },
      });`,
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
    case: "does not let a sibling win over an app whose config returns app.json's config changed",
    files: {
      "apps/mobile/app.config.js": `module.exports = ({ config }) => {
        config.name = "Mobile";
        return config;
      };`,
      "apps/mobile/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a spread of an identifier starting with config may replace app.json's id",
    files: {
      "app.config.js": `const config$ = require("./app.local.js");
        module.exports = ({ config }) => ({ ...config, ...config$ });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when that identifier is spelled with a Unicode escape",
    files: {
      "app.config.js": `const config$ = require("./app.local.js");
        module.exports = ({ config }) => ({ ...config, ...config\\u0024 });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config spreads the config but replaces extra",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, extra: {} });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config spreads the config but replaces a quoted extra",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, "extra": {} });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config spreads the config but replaces a computed extra",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, ["extra"]: {} });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config spreads the config but replaces extra by shorthand",
    files: {
      "app.config.js": `const extra = {};\nmodule.exports = ({ config }) => ({ ...config, extra });`,
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
    case: "gives no answer when a config assigns extra in brackets after a literal id",
    files: {
      "app.config.js": `module.exports = ({ config }) => {
        const c = { ...config, extra: { eas: { projectId: "${ID_A}" } } };
        c["extra"] = other();
        return c;
      };`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config deletes from the config it spreads",
    files: {
      "app.config.js": `module.exports = ({ config }) => {
        delete config.extra;
        return { ...config };
      };`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config spreads part of the config over it",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, ...config.extra.preview });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config spreads a property of the config instead of it",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config.preview });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when an extra entry spreads the whole config, not its extra",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, extra: { ...config } });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when an eas entry spreads the config's extra, not its eas",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({ ...config, extra: { ...config.extra, eas: { ...config.extra } } });`,
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
    case: "gives no answer when a config spreads the config but replaces eas",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({
        ...config,
        extra: { ...config.extra, eas: { build: { experimental: true } } },
      });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "reads app.json's project id through a config that only spreads the config itself",
    files: {
      "app.config.js": `module.exports = ({ config }) => ({
        ...config,
        extra: { ...config.extra, eas: { ...(config.extra?.eas ?? {}) }, apiUrl: process.env.API_URL },
      });`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.some(ID_A),
  },
  {
    case: "gives no answer when a config may return another file's config on some builds",
    files: {
      "app.config.js": `module.exports = process.env.PROD
        ? { extra: { eas: { projectId: "${ID_A}" } } }
        : require("./app.config.staging.js");`,
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config assigns over the object holding the project id",
    files: {
      "app.config.js": `export default ({ config }) => {
        const c = { extra: { eas: { projectId: "${ID_A}" } } };
        c.extra.eas = require("./eas.local.js");
        return c;
      };`,
    },
    expected: Option.none(),
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
    case: "gives no answer when a config joins the project id across lines",
    files: {
      "apps/mobile/app.config.ts": `export default {
        extra: { eas: { projectId: "${ID_A.slice(0, 9)}"
          + "${ID_A.slice(9)}" } },
      };`,
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    },
    expected: Option.none(),
  },
  {
    case: "gives no answer when a config builds the project id in a template",
    files: {
      "app.config.js":
        "export default { extra: { eas: { projectId: `${process.env.EAS_PROJECT_ID}` } } };",
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    },
    expected: Option.none(),
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
    case: "reads a static config that is not wrapped in `expo`",
    files: {
      "apps/mobile/app.config.json": JSON.stringify({ extra: { eas: { projectId: ID_A } } }),
      "apps/README.md": "one app",
    },
    expected: Option.some(ID_A),
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

it.effect("reads app.config.json like app.json", () =>
  Effect.gen(function* () {
    const root = yield* workspace({
      "app.config.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    expect(yield* findEasProjectId(root)).toEqual(Option.some(ID_B));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["\r", "\u2028", "\u2029"])(
  "gives no answer when a comment ending in %o precedes the rest of a joined id",
  (terminator) =>
    Effect.gen(function* () {
      // A line comment ends at any ECMAScript line terminator, not only LF.
      const root = yield* workspace({
        "apps/mobile/app.config.ts":
          `export default { extra: { eas: { projectId: "${ID_A.slice(0, 9)}" // prefix${terminator}` +
          `+ "${ID_A.slice(9)}" } } };`,
        "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
      });
      expect(yield* findEasProjectId(root)).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  {
    case: "a long run of spaces after a spread",
    source: `({ config }) => ({ ...${" ".repeat(255 * 1024)}config })`,
  },
  {
    case: "many spreads inside one comment",
    source: `({ config }) => ({ .../*${".../*".repeat(30_000)}*/config })`,
  },
  {
    case: "many spreads inside line comments",
    source: `({ config }) => ({ ...//${" ...//".repeat(30_000)}\nconfig })`,
  },
])("reads $case at once", ({ source }) =>
  Effect.gen(function* () {
    const root = yield* workspace({
      "app.config.js": `module.exports = ${source};`,
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
    });
    const startedAt = performance.now();
    expect(yield* findEasProjectId(root)).toEqual(Option.some(ID_A));
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("gives no answer at once for a config with more entries than one can have", () =>
  Effect.gen(function* () {
    // Just under the size bound, every entry followed by an unterminated
    // comment would still take seconds; the entry count stops it first.
    const entry = `projectId: "${ID_A.slice(0, 9)}" /* `;
    const root = yield* workspace({
      "apps/mobile/app.config.ts": entry.repeat(Math.floor((255 * 1024) / entry.length)),
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    const startedAt = performance.now();
    expect(yield* findEasProjectId(root)).toEqual(Option.none());
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("gives no answer at once for a config too large to be one", () =>
  Effect.gen(function* () {
    // Each entry followed by an unterminated comment scans to the end of the
    // file: quadratic on a file made for it. A config this large is unknown.
    const entry = `projectId: "${ID_A.slice(0, 9)}" /* `;
    const root = yield* workspace({
      "apps/mobile/app.config.ts": entry.repeat(Math.ceil((1024 * 1024) / entry.length)),
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    // The bound is loose for a loaded test machine; the slow cases take minutes.
    const startedAt = performance.now();
    expect(yield* findEasProjectId(root)).toEqual(Option.none());
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("answers at once for a long comment before the rest of a joined id", () =>
  Effect.gen(function* () {
    // A comment with many slashes before a continuation made an earlier
    // matcher try every way to split it into comments: minutes, not ms.
    const urls = Array.from({ length: 40 }, () => "https://expo.dev").join(" ");
    const root = yield* workspace({
      "apps/mobile/app.config.ts": `export default {
        extra: { eas: { projectId: "${ID_A.slice(0, 9)}" // ${urls}
          + "${ID_A.slice(9)}" } },
      };`,
      "apps/kiosk/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    // The bound is loose for a loaded test machine; the slow cases take minutes.
    const startedAt = performance.now();
    expect(yield* findEasProjectId(root)).toEqual(Option.none());
    expect(performance.now() - startedAt).toBeLessThan(10_000);
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
