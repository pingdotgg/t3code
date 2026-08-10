import { describe, expect, it } from "@effect/vitest";
import { createHashHistory, createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vite-plus/test";

import { resolveProductDomainFromRouteIds } from "./productDomain";
import { MarketingRouteNotFoundView } from "./routes/marketing.$.lazy";
import { MarketingDomainPlaceholder } from "./routes/marketing.index.lazy";
import {
  MarketingDomainErrorView,
  MarketingDomainPendingView,
  MarketingVerifiedActorRequiredError,
  resolveMarketingRouteAccess,
} from "./routes/marketing";
import { resolvePairRouteDestination } from "./routes/pair";

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class TestDiffWorker {
    readonly testWorker = true;
  },
}));

async function matchRouteIds(history: RouterHistory): Promise<ReadonlyArray<string>> {
  const { getRouter } = await import("./router");
  const router = getRouter(history);
  return router.matchRoutes(history.location.pathname).map((match) => match.routeId);
}

function matchMemoryPath(pathname: string): Promise<ReadonlyArray<string>> {
  return matchRouteIds(createMemoryHistory({ initialEntries: [pathname] }));
}

function createDesktopHashWindow(hash: string): Window {
  const location = { pathname: "/index.html", search: "", hash };
  const history = {
    state: null as unknown,
    length: 1,
    pushState(state: unknown, _unused: string, href?: string | URL | null) {
      this.state = state;
      if (href) location.hash = String(href).split("#").slice(1).join("#");
    },
    replaceState(state: unknown, _unused: string, href?: string | URL | null) {
      this.state = state;
      if (href) location.hash = String(href).split("#").slice(1).join("#");
    },
    back() {},
    forward() {},
    go() {},
  };
  return {
    location,
    history,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Marketing route boundary", () => {
  it("structurally reserves exact, deep, and unknown Marketing paths", async () => {
    for (const pathname of ["/marketing", "/marketing/sources", "/marketing/unknown"]) {
      const routeIds = await matchMemoryPath(pathname);
      expect(routeIds).toContain("/marketing");
      expect(resolveProductDomainFromRouteIds(routeIds)).toBe("marketing");
      expect(routeIds).not.toContain("/_chat/$environmentId/$threadId");
    }

    await expect(matchMemoryPath("/marketing")).resolves.toContain("/marketing/");
    await expect(matchMemoryPath("/marketing/sources")).resolves.toContain("/marketing/$");
  });

  it("keeps malformed, case-mismatched, and adjacent paths in Dev", async () => {
    for (const pathname of ["/Marketing", "/marketing-tools", "/settings"]) {
      const routeIds = await matchMemoryPath(pathname);
      expect(routeIds, pathname).not.toContain("/marketing");
      expect(resolveProductDomainFromRouteIds(routeIds)).toBe("dev");
    }
  });

  it("returns from the reserved Marketing namespace to native Dev", async () => {
    const history = createMemoryHistory({ initialEntries: ["/marketing"] });

    expect(await matchRouteIds(history)).toContain("/marketing");
    history.replace("/");
    const routeIds = await matchRouteIds(history);

    expect(routeIds).not.toContain("/marketing");
    expect(resolveProductDomainFromRouteIds(routeIds)).toBe("dev");
  });

  it("reserves the same Marketing namespace through desktop hash history", async () => {
    const history = createHashHistory({
      window: createDesktopHashWindow("#/marketing/sources"),
    });
    expect(history.location.pathname).toBe("/marketing/sources");
    await expect(matchRouteIds(history)).resolves.toContain("/marketing/$");
    history.destroy();
  });

  it("gates local clients through pairing and fails hosted static closed", () => {
    expect(resolveMarketingRouteAccess("authenticated", "/marketing/sources")).toEqual({
      kind: "allow",
    });
    expect(resolveMarketingRouteAccess("requires-auth", "/marketing/sources")).toEqual({
      kind: "pair",
      returnTo: "/marketing/sources",
    });
    expect(resolveMarketingRouteAccess("hosted-pairing", "/marketing/../settings")).toEqual({
      kind: "pair",
      returnTo: "/marketing",
    });
    expect(resolveMarketingRouteAccess("hosted-static", "/marketing")).toEqual({
      kind: "connect-required",
    });
    expect(resolvePairRouteDestination(undefined)).toEqual({ to: "/" });
    expect(resolvePairRouteDestination("/marketing")).toEqual({ to: "/marketing" });
    expect(resolvePairRouteDestination("/marketing/")).toEqual({ to: "/marketing" });
    expect(resolvePairRouteDestination("/marketing/sources")).toEqual({
      to: "/marketing/$",
      params: { _splat: "sources" },
    });
    expect(resolvePairRouteDestination("/marketing/../settings")).toEqual({ to: "/" });
    expect(resolvePairRouteDestination("/Marketing")).toEqual({ to: "/" });
  });

  it("stops hosted-static routing before the Marketing payload can load", async () => {
    vi.resetModules();
    let payloadImported = false;
    vi.doMock("./routes/marketing.index.lazy", async (importOriginal) => {
      payloadImported = true;
      return importOriginal();
    });

    try {
      const { getRouter } = await import("./router");
      const router = getRouter(createMemoryHistory({ initialEntries: ["/marketing"] }));
      router.routesById.__root__.options.beforeLoad = async () => ({
        authGateState: { status: "hosted-static" as const },
      });

      await router.load();

      expect(payloadImported).toBe(false);
      const marketingMatch = router.state.matches.find((match) => match.routeId === "/marketing");
      expect(marketingMatch?.status).toBe("error");
      expect(marketingMatch?.error).toMatchObject({
        name: "MarketingVerifiedActorRequiredError",
      });
    } finally {
      vi.doUnmock("./routes/marketing.index.lazy");
      vi.resetModules();
    }
  });

  it("redirects a pairing-gated Marketing deep link before loading its payload", async () => {
    vi.resetModules();
    let payloadImported = false;
    vi.doMock("./routes/marketing.index.lazy", async (importOriginal) => {
      payloadImported = true;
      return importOriginal();
    });

    try {
      const { getRouter } = await import("./router");
      const router = getRouter(
        createMemoryHistory({ initialEntries: ["/marketing/private-brief"] }),
      );
      router.routesById.__root__.options.beforeLoad = async () => ({
        authGateState: { status: "hosted-pairing" as const },
      });

      await router.load();

      expect(payloadImported).toBe(false);
      expect(router.state.redirect?.options).toMatchObject({
        to: "/pair",
        search: { marketingReturnTo: "/marketing/private-brief" },
        replace: true,
      });
    } finally {
      vi.doUnmock("./routes/marketing.index.lazy");
      vi.resetModules();
    }
  });

  it("exposes an accessible pending state from the non-lazy boundary", () => {
    const markup = renderToStaticMarkup(<MarketingDomainPendingView />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("The isolated Marketing workspace is loading.");
  });

  it("keeps the non-lazy pending boundary available during a delayed payload import", async () => {
    vi.resetModules();
    const importEntered = deferred<void>();
    const releaseImport = deferred<void>();
    vi.doMock("./routes/marketing.index.lazy", async (importOriginal) => {
      importEntered.resolve();
      await releaseImport.promise;
      return importOriginal();
    });

    try {
      const { getRouter } = await import("./router");
      const router = getRouter(createMemoryHistory({ initialEntries: ["/marketing"] }));
      router.routesById.__root__.options.beforeLoad = async () => ({
        authGateState: { status: "authenticated" as const },
      });

      let settled = false;
      const load = router.load().then(() => {
        settled = true;
      });
      await importEntered.promise;

      expect(settled).toBe(false);
      expect(router.routesById["/marketing"].options.pendingMs).toBe(0);
      expect(router.routesById["/marketing"].options.pendingComponent).toBeDefined();

      releaseImport.resolve();
      await load;
      expect(router.state.matches.map((match) => match.routeId)).toContain("/marketing/");
    } finally {
      releaseImport.resolve();
      vi.doUnmock("./routes/marketing.index.lazy");
      vi.resetModules();
    }
  });

  it("routes a rejected Marketing payload import to the static containment boundary", async () => {
    vi.resetModules();
    vi.doMock("./routes/marketing.index.lazy", () => {
      const rejectedModule = {};
      Object.defineProperty(rejectedModule, "Route", {
        get() {
          throw new Error("marketing chunk failed");
        },
      });
      return rejectedModule;
    });

    try {
      const { getRouter } = await import("./router");
      const router = getRouter(createMemoryHistory({ initialEntries: ["/marketing"] }));
      const lazyImport = router.routesById["/marketing/"].lazyFn;

      expect(lazyImport).toBeDefined();
      await expect(lazyImport?.()).rejects.toThrow("marketing chunk failed");
      expect(router.routesById["/marketing"].options.errorComponent).toBeDefined();

      const markup = renderToStaticMarkup(
        <MarketingDomainErrorView
          error={new Error("marketing chunk failed")}
          reset={() => {}}
          devExit={<a href="/">Return to Dev</a>}
        />,
      );
      expect(markup).toContain("This failure is contained to Marketing.");
      expect(markup).toContain('<a href="/">Return to Dev</a>');
    } finally {
      vi.doUnmock("./routes/marketing.index.lazy");
      vi.resetModules();
    }
  });

  it("contains Marketing failures and hosted-static access without exposing data", () => {
    const errorMarkup = renderToStaticMarkup(
      <MarketingDomainErrorView
        error={new Error("Marketing failed to load")}
        reset={() => {}}
        devExit={<a href="/">Return to Dev</a>}
      />,
    );
    const hostedStaticMarkup = renderToStaticMarkup(
      <MarketingDomainErrorView
        error={new MarketingVerifiedActorRequiredError("Actor required")}
        reset={() => {}}
        connectionsLink={<a href="/settings/connections">Open Connections</a>}
        devExit={<a href="/">Return to Dev</a>}
      />,
    );

    expect(errorMarkup).toContain("This failure is contained to Marketing.");
    expect(errorMarkup).toContain("Native T3 Dev is still available.");
    expect(errorMarkup).toContain("Marketing failed to load");
    expect(errorMarkup).toContain('<a href="/">Return to Dev</a>');
    expect(hostedStaticMarkup).toContain("Connect an environment to use Marketing");
    expect(hostedStaticMarkup).toContain("No Marketing data was loaded.");
    expect(hostedStaticMarkup).toContain("Open Connections");
  });

  it("keeps exact and unknown Marketing payloads explicit about their boundaries", () => {
    const exactMarkup = renderToStaticMarkup(
      <MarketingDomainPlaceholder devExit={<a href="/">Return to Dev</a>} />,
    );
    const unknownMarkup = renderToStaticMarkup(
      <MarketingRouteNotFoundView
        marketingLink={<a href="/marketing">Open Marketing</a>}
        devExit={<a href="/">Return to Dev</a>}
      />,
    );

    expect(exactMarkup).toContain("The isolated Marketing product domain is active.");
    expect(unknownMarkup).toContain("This address is reserved for Marketing");
  });
});
