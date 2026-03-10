import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ReplayFixture } from "./types.ts";

interface FixtureModule {
  readonly default?: ReplayFixture | Record<string, ReplayFixture>;
}

function fixturePathForTestFile(testFileUrl: string): string {
  const testFilePath = fileURLToPath(testFileUrl);
  const extension = path.extname(testFilePath);
  if (!extension) {
    throw new Error(`Cannot derive replay fixture path from '${testFilePath}'.`);
  }
  return `${testFilePath.slice(0, -extension.length)}.fixture.ts`;
}

export async function readReplayFixture(
  testFileUrl: string,
  fixtureName?: string,
): Promise<ReplayFixture> {
  const fixturePath = fixturePathForTestFile(testFileUrl);
  const module = (await import(pathToFileURL(fixturePath).href)) as FixtureModule;
  const fixtureExport = module.default;
  if (!fixtureExport) {
    throw new Error(`Replay fixture '${fixturePath}' must export a default value.`);
  }
  if (!fixtureName) {
    if ("interactions" in fixtureExport && "version" in fixtureExport) {
      return fixtureExport as ReplayFixture;
    }
    throw new Error(`Replay fixture '${fixturePath}' exports named fixtures; provide fixtureName.`);
  }

  if ("interactions" in fixtureExport) {
    throw new Error(
      `Replay fixture '${fixturePath}' exports a single fixture; fixtureName is not supported.`,
    );
  }
  const fixture = fixtureExport[fixtureName];
  if (!fixture) {
    throw new Error(`Replay fixture '${fixturePath}' does not include fixture '${fixtureName}'.`);
  }
  return fixture;
}
