import { describe, expect, it, vi } from "vite-plus/test";

import type { OpenVsxThemeExtension, OpenVsxThemeSort } from "../../openVsxThemes";
import { createThemeSearch, type ThemeSearchView } from "./ThemeSearchSection";

interface Request {
  readonly query: string;
  readonly sortBy: OpenVsxThemeSort | undefined;
  readonly signal: AbortSignal | undefined;
  resolve(results: OpenVsxThemeExtension[]): void;
  reject(cause: unknown): void;
}

function setup() {
  vi.useFakeTimers();
  const requests: Request[] = [];
  const search = (
    query: string,
    options: { signal?: AbortSignal; sortBy?: OpenVsxThemeSort } = {},
  ) =>
    new Promise<OpenVsxThemeExtension[]>((resolve, reject) => {
      requests.push({ query, sortBy: options.sortBy, signal: options.signal, resolve, reject });
    });
  const view = {
    results: null as ReadonlyArray<OpenVsxThemeExtension> | null,
    error: null as string | null,
    isSearching: false,
  };
  const sink: ThemeSearchView = {
    setResults: (results) => {
      view.results = results;
    },
    setError: (error) => {
      view.error = error;
    },
    setIsSearching: (isSearching) => {
      view.isSearching = isSearching;
    },
  };
  const session = new AbortController();
  const themeSearch = createThemeSearch(sink, session.signal, search);
  return {
    requests,
    view,
    session,
    themeSearch,
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

const extension = (name: string) => ({ name }) as OpenVsxThemeExtension;
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("createThemeSearch", () => {
  it("searches once the typed query settles", async () => {
    using env = setup();
    env.themeSearch.setQuery("dra");
    env.themeSearch.setQuery("dracula ");
    await vi.advanceTimersByTimeAsync(349);
    expect(env.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.requests.map((request) => request.query)).toEqual(["dracula"]);
    expect(env.view.isSearching).toBe(true);

    env.requests[0]!.resolve([extension("Dracula")]);
    await flush();
    expect(env.view.results).toEqual([extension("Dracula")]);
    expect(env.view.isSearching).toBe(false);
  });

  it("keeps the shown results when typing returns to their query", async () => {
    using env = setup();
    env.themeSearch.setQuery("nord");
    await vi.advanceTimersByTimeAsync(350);
    env.requests[0]!.resolve([extension("Nord")]);
    await flush();

    env.themeSearch.setQuery("nordic");
    await vi.advanceTimersByTimeAsync(350);
    env.themeSearch.setQuery("nord");
    await vi.advanceTimersByTimeAsync(350);

    expect(env.requests).toHaveLength(2);
    expect(env.requests[1]!.signal?.aborted).toBe(true);
    expect(env.view.results).toEqual([extension("Nord")]);
    expect(env.view.isSearching).toBe(false);
  });

  it("searches again right away when the sort changes", async () => {
    using env = setup();
    env.themeSearch.setQuery("nord");
    await vi.advanceTimersByTimeAsync(350);
    env.themeSearch.setSortBy("rating");
    expect(env.requests[0]!.signal?.aborted).toBe(true);
    expect(env.requests[1]).toMatchObject({ query: "nord", sortBy: "rating" });
  });

  it("clearing the query drops results and the request in flight", async () => {
    using env = setup();
    env.themeSearch.setQuery("nord");
    await vi.advanceTimersByTimeAsync(350);
    env.themeSearch.setQuery("  ");
    expect(env.requests[0]!.signal?.aborted).toBe(true);
    expect(env.view).toEqual({ results: null, error: null, isSearching: false });
  });

  it("holds searches during an install and keeps its error on the shown query", async () => {
    using env = setup();
    env.themeSearch.setQuery("nord");
    await vi.advanceTimersByTimeAsync(350);
    env.requests[0]!.resolve([extension("Nord")]);
    await flush();

    const install = env.themeSearch.beginInstall();
    env.view.error = "That theme could not be added.";
    env.themeSearch.searchNow();
    expect(env.requests).toHaveLength(1);
    expect(env.themeSearch.endInstall(install)).toBe(true);
    expect(env.requests).toHaveLength(1);
    expect(env.view.error).toBe("That theme could not be added.");

    const next = env.themeSearch.beginInstall();
    env.themeSearch.setQuery("dracula");
    await vi.advanceTimersByTimeAsync(350);
    expect(env.requests).toHaveLength(1);
    env.themeSearch.endInstall(next);
    expect(env.requests.map((request) => request.query)).toEqual(["nord", "dracula"]);
    expect(env.view.error).toBeNull();
  });

  it("Enter during the debounce searches once", async () => {
    using env = setup();
    env.themeSearch.setQuery("nord");
    env.themeSearch.searchNow();
    await vi.advanceTimersByTimeAsync(350);
    expect(env.requests.map((request) => request.query)).toEqual(["nord"]);
    expect(env.requests[0]!.signal?.aborted).toBe(false);
  });

  it("closing the session aborts the search, the debounce, and the install", async () => {
    using env = setup();
    env.themeSearch.setQuery("nord");
    await vi.advanceTimersByTimeAsync(350);
    const install = env.themeSearch.beginInstall();
    env.themeSearch.setQuery("dracula");
    env.session.abort();
    await vi.advanceTimersByTimeAsync(350);
    expect(env.requests[0]!.signal?.aborted).toBe(true);
    expect(install.aborted).toBe(true);
    expect(env.requests).toHaveLength(1);
  });
});
