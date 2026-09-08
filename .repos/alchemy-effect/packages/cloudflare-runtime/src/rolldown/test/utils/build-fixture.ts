import path from "node:path";
import type {
  InputOptions,
  OutputChunk,
  OutputOptions,
  RolldownOutput,
  RolldownPluginOption,
} from "rolldown";
import { rolldown } from "rolldown";
import type { RolldownPluginOptions } from "../../plugin.ts";
import cloudflare from "../../plugin.ts";
import { getEntryChunk } from "./output.ts";

const DEFAULT_PLUGIN_OPTIONS: RolldownPluginOptions = {
  compatibilityDate: "2025-07-01",
};

interface BuildFixtureOptions {
  fixture: string;
  pluginOptions?: RolldownPluginOptions;
  plugins?: Array<RolldownPluginOption>;
  inputOptions?: Omit<InputOptions, "input" | "plugins">;
  generateOptions?: Omit<OutputOptions, "file" | "format" | "sourcemap">;
}

export interface BuiltFixture {
  fixture: string;
  output: RolldownOutput;
  entry: OutputChunk;
}

export async function buildFixture(
  options: BuildFixtureOptions,
): Promise<BuiltFixture> {
  const fixture = normalizeFixturePath(options.fixture);
  const bundle = await rolldown({
    input: fixture,
    ...(options.inputOptions ?? {}),
    plugins: [
      ...(options.plugins ?? []),
      cloudflare(options.pluginOptions ?? DEFAULT_PLUGIN_OPTIONS),
    ],
  });

  try {
    const output = await bundle.write({
      file: defaultOutputPath(fixture),
      format: "esm",
      sourcemap: true,
      ...(options.generateOptions ?? {}),
    });
    return {
      fixture,
      output,
      entry: getEntryChunk(output),
    };
  } finally {
    await bundle.close();
  }
}

function normalizeFixturePath(fixture: string): string {
  return path.isAbsolute(fixture)
    ? fixture
    : path.join("test", "fixtures", fixture);
}

function defaultOutputPath(fixture: string): string {
  const fixtureName =
    path.basename(path.dirname(fixture)) === "fixtures"
      ? path.basename(fixture, path.extname(fixture))
      : path.basename(path.dirname(fixture));
  return path.join("out", fixtureName, "index.js");
}
