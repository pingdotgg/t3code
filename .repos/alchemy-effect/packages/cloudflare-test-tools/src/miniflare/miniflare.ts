import { Miniflare, type MiniflareOptions, type Response } from "miniflare";
import type { RolldownOutput } from "rolldown";
import { miniflareModulesFromRolldownOutput } from "./miniflare-module.ts";

export interface MiniflareInstance {
  url: URL;
  fetch(path: string): Promise<Response>;
  fetchText(path: string): Promise<string>;
  fetchJson<T>(path: string): Promise<T>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

export type Options = Extract<MiniflareOptions, { modules: Array<any> }>;

export async function createMiniflare(
  options: Options,
): Promise<MiniflareInstance> {
  const miniflare = new Miniflare(options);
  const url = await miniflare.ready;
  const fetch = (path: string) =>
    miniflare.dispatchFetch(`http://localhost${path}`);
  return {
    url,
    fetch,
    fetchText: (path: string) =>
      fetch(path).then((response) => response.text()),
    fetchJson: <T>(path: string) =>
      fetch(path).then((response) => response.json() as Promise<T>),
    [Symbol.asyncDispose]: () => miniflare.dispose(),
  };
}

export async function createMiniflareFromRolldown(
  output: RolldownOutput,
  options: Partial<Options> = {},
): Promise<MiniflareInstance> {
  return createMiniflare({
    modules: miniflareModulesFromRolldownOutput(output.output),
    ...options,
  });
}
