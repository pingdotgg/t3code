"use strict";

// Fixture for uniwind-platform-variants.test.ts. Run as a plain Node process
// (`node uniwind-platform-variants.fixture.cjs <fixtureDir>`) so it executes the
// real compiler with no test-runner transforms in the way. Prints one JSON
// object to stdout describing what each platform bundle compiled.
//
// It reproduces what the Metro transformer does for `global.css`: compile the
// Tailwind entry, then run uniwind's CSS processor and stylesheet serializer
// once per platform. Loading `dist/common` needs a small custom loader because
// uniwind declares `"type": "module"` over that CommonJS output and its
// internal `@/...` import alias only exists at uniwind's own build time; the
// loader hands unmodified file bytes to V8 and resolves those aliases the same
// way, so this runs the exact compiled code the Metro transformer bundles.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

function createUniwindCompilerLoader(uniwindPackageJson) {
  const uniwindRoot = path.dirname(fs.realpathSync(uniwindPackageJson));
  const uniwindRequire = createRequire(path.join(uniwindRoot, "package.json"));
  const cache = new Map();

  const load = (absoluteFileWithoutExtension) => {
    const resolved = [
      absoluteFileWithoutExtension,
      `${absoluteFileWithoutExtension}.js`,
      path.join(absoluteFileWithoutExtension, "index.js"),
    ].find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (resolved === undefined) {
      throw new Error(`Cannot resolve uniwind module ${absoluteFileWithoutExtension}`);
    }
    const cached = cache.get(resolved);
    if (cached !== undefined) return cached;

    const cjsModule = { exports: {} };

    const localRequire = (request) => {
      if (request.startsWith("@/")) {
        return load(path.join(uniwindRoot, "dist/common", request.slice(2)));
      }
      if (request.startsWith(".")) {
        return load(path.resolve(path.dirname(resolved), request));
      }
      // uniwind's own dependencies (lightningcss, culori, ...) resolve through
      // the package's dependency tree, like they do inside the Metro bundle.
      return uniwindRequire(request);
    };

    const code = fs.readFileSync(resolved, "utf8");
    new Function("require", "module", "exports", code)(localRequire, cjsModule, cjsModule.exports);
    cache.set(resolved, cjsModule.exports);
    return cjsModule.exports;
  };

  const loadBundler = (request) => load(path.join(uniwindRoot, "dist/common", request));
  return { loadBundler, uniwindRequire, uniwindRoot };
}

async function main() {
  const fixtureDir = fs.realpathSync(path.resolve(process.argv[2]));
  const uniwindPackageJson = require.resolve("uniwind/package.json", {
    paths: [fixtureDir],
  });
  const { loadBundler, uniwindRequire, uniwindRoot } =
    createUniwindCompilerLoader(uniwindPackageJson);
  const { ProcessorBuilder } = loadBundler("bundler/css-processor/processor.js");
  const { addMetaToStylesTemplate } = loadBundler(
    "bundler/css-processor/addMetaToStylesTemplate.js",
  );
  const { compileNativeCSS } = loadBundler("bundler/css-compiler/compileNativeCSS.js");

  const { compile } = uniwindRequire("@tailwindcss/node");
  const { Scanner } = uniwindRequire("@tailwindcss/oxide");
  const compiler = await compile(fs.readFileSync(path.join(fixtureDir, "global.css"), "utf8"), {
    base: fixtureDir,
    onDependency: () => {},
  });
  const scanner = new Scanner({
    sources: [...compiler.sources, { negated: false, pattern: "**/*.tsx", base: fixtureDir }],
  });
  const tailwindCSS = await compiler.build(scanner.scan());

  const platforms = {};
  // Every ios:/android: utility class Tailwind generated for the fixture.
  const compiledGuardedClasses = {};
  for (const match of tailwindCSS.matchAll(/\.(ios|android)\\:([^{ ,]+) \{/g)) {
    compiledGuardedClasses[`${match[1]}:${match[2]}`.replace(/\\(.)/g, "$1")] = true;
  }
  const platformBlock = (name) =>
    new RegExp(`@media ${name} \\{([\\s\\S]*?)\\n  \\}`).exec(tailwindCSS)?.[1] ?? "";
  const utilityCountIn = (block) => (block.match(/^\s+\.[^ ]+ \{/gm) ?? []).length;
  const tailwindChecks = {
    iosBlocks: (tailwindCSS.match(/@media ios \{/g) ?? []).length,
    androidBlocks: (tailwindCSS.match(/@media android \{/g) ?? []).length,
    iosUtilities: utilityCountIn(platformBlock("ios")),
    androidUtilities: utilityCountIn(platformBlock("android")),
  };
  for (const platform of ["ios", "android"]) {
    // Same config the app's withUniwindConfig produces (polyfills.rem: 14).
    const bundlerConfig = { platform, themes: ["light", "dark"], polyfills: { rem: 14 } };
    const processor = new ProcessorBuilder(bundlerConfig);
    processor.transform(tailwindCSS);
    const compiled = addMetaToStylesTemplate(processor, platform);
    const payload = compileNativeCSS(bundlerConfig, tailwindCSS);
    const styles = {};
    for (const [className, entries] of Object.entries(compiled)) {
      styles[className] = entries.map(
        ({ native, minWidth, maxWidth, active, focus, disabled, dataAttributes }) => ({
          native,
          minWidth,
          maxWidth,
          active: active ?? null,
          focus: focus ?? null,
          disabled: disabled ?? null,
          dataAttributes: dataAttributes ?? null,
        }),
      );
    }
    platforms[platform] = {
      styles,
      payloadIncludesAllCompiled: Object.keys(compiled).every((className) =>
        payload.includes(`"${className}"`),
      ),
      // A utility dropped from this platform's stylesheet must not appear
      // anywhere in the payload the bundle embeds for this platform.
      payloadLeaks: Object.keys(compiledGuardedClasses)
        .filter((className) => compiled[className] === undefined)
        .filter((className) => payload.includes(`"${className}"`)),
    };
  }

  // Exercise the real Metro transformer entry point (the shipped
  // `dist/metro/transformer.cjs`, not a copy) with a stubbed downstream worker,
  // to check what the global.css virtual module actually becomes — including
  // the native styles fingerprint that lets dev reloads skip reinitializing.
  const transformerPath = path.join(uniwindRoot, "dist/metro/transformer.cjs");
  let reinitCode = "";
  const Module = require("node:module");
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "metro-transform-worker") {
      return {
        transform: async (_config, _root, _file, data) => {
          reinitCode = data.toString();
          return { output: [{ data: {} }] };
        },
      };
    }
    return origLoad.call(this, request, ...rest);
  };
  process.chdir(fixtureDir);
  try {
    const { transform } = require(transformerPath);
    await transform(
      { uniwind: { cssEntryFile: "./global.css", isExpoProject: false } },
      fixtureDir,
      "global.css",
      Buffer.from(""),
      { platform: "ios", type: "module" },
    );
  } finally {
    Module._load = origLoad;
  }
  const transformerCheck = {
    reinitPayload: reinitCode.includes("Uniwind.__reinit(rt =>"),
    fingerprintArg: /, '[0-9a-f]{64}'\);\s*$/.test(reinitCode),
    themesArg: reinitCode.includes("['light', 'dark']"),
  };

  process.stdout.write(JSON.stringify({ tailwindChecks, transformerCheck, platforms }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
