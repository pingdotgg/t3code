import { describe, expect, it } from "vite-plus/test";

import { isAllowedConnQuery, resolveConnUrl, resolveRootUrl } from "./orbitGateway.ts";

describe("resolveConnUrl", () => {
  it("keeps ordinary Conn paths below the prefix", () => {
    expect(resolveConnUrl("/me")?.pathname).toBe("/api/v1/conn/me");
    expect(resolveConnUrl("/instances/41/destroy")?.pathname).toBe(
      "/api/v1/conn/instances/41/destroy",
    );
    expect(resolveConnUrl("/profiles/1/settings")?.pathname).toBe(
      "/api/v1/conn/profiles/1/settings",
    );
    expect(resolveConnUrl("/")?.pathname).toBe("/api/v1/conn/");
  });

  it.each([
    "/../nodes",
    "/../../../v1/nodes",
    "/./me",
    "/..",
    "/%2e%2e/nodes",
    "/%2E%2E/nodes",
    "/.%2e/nodes",
    "/%2e/me",
    "/profiles/%2e%2e/%2e%2e/nodes",
    "/..%2fnodes",
    "/%2e%2e%2fnodes",
    "/%",
    "/%zz",
  ])("rejects %s", (path) => {
    expect(resolveConnUrl(path)).toBeNull();
  });

  it("allows dots inside a segment name", () => {
    expect(resolveConnUrl("/profiles/a..b")?.pathname).toBe("/api/v1/conn/profiles/a..b");
  });
});

describe("isAllowedConnQuery", () => {
  const get = (path: string, query?: Record<string, string>) => ({
    method: "GET" as const,
    path,
    ...(query ? { query } : {}),
  });

  it("lets a request without a query through on any path", () => {
    expect(isAllowedConnQuery(get("/me"))).toBe(true);
    expect(isAllowedConnQuery(get("/projects", {}))).toBe(true);
  });

  it("allows the name check's name and the project list's include_unavailable=1", () => {
    expect(isAllowedConnQuery(get("/projects/66/instances/check", { name: "pricing-page" }))).toBe(
      true,
    );
    expect(isAllowedConnQuery(get("/projects/66/instances/check", { name: "default" }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects", { include_unavailable: "1" }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects/66/branches", { query: "feature/Login" }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects/66/branches", { query: "a".repeat(200) }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects/66/branches"))).toBe(true);
    expect(isAllowedConnQuery(get("/tasks", { project: "78", limit: "100" }))).toBe(true);
    expect(
      isAllowedConnQuery(
        get("/tasks", {
          project: "78",
          instance: "3599",
          status: "waiting_for_review",
          cursor: "5700",
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["another key", get("/projects/66/instances/check", { query: "x" })],
    ["an extra key", get("/projects/66/instances/check", { name: "a", limit: "5" })],
    ["a bad name", get("/projects/66/instances/check", { name: "Bad Name" })],
    ["a name over 63 characters", get("/projects/66/instances/check", { name: "a".repeat(64) })],
    ["an empty name", get("/projects/66/instances/check", { name: "" })],
    ["a non-numeric project", get("/projects/x/instances/check", { name: "a" })],
    ["include_unavailable=true", get("/projects", { include_unavailable: "true" })],
    ["include_unavailable=0", get("/projects", { include_unavailable: "0" })],
    [
      "include_unavailable with another key",
      get("/projects", { include_unavailable: "1", a: "b" }),
    ],
    ["a query on another path", get("/environments", { include_unavailable: "1" })],
    [
      "a branch search over 200 characters",
      get("/projects/66/branches", { query: "a".repeat(201) }),
    ],
    ["an empty branch search", get("/projects/66/branches", { query: "" })],
    ["a branch search with a control character", get("/projects/66/branches", { query: "a\nb" })],
    ["another key on branches", get("/projects/66/branches", { name: "main" })],
    ["an extra key on branches", get("/projects/66/branches", { query: "a", limit: "5" })],
    ["branches of a non-numeric project", get("/projects/x/branches", { query: "a" })],
    ["another key on tasks", get("/tasks", { project: "78", search: "a" })],
    ["a task list limit over 100", get("/tasks", { limit: "101" })],
    ["a non-numeric task cursor", get("/tasks", { cursor: "abc" })],
    ["a query on one task", get("/tasks/5753", { project: "78" })],
    ["a POST", { method: "POST" as const, path: "/projects", query: { include_unavailable: "1" } }],
  ])("refuses %s", (_label, request) => {
    expect(isAllowedConnQuery(request)).toBe(false);
  });
});

describe("resolveRootUrl", () => {
  it("allows only an Instance wake and an Operation read below /api/v1", () => {
    expect(resolveRootUrl({ method: "POST", path: "/instances/41/wake" })?.toString()).toBe(
      "https://gateway.orbit/api/v1/instances/41/wake",
    );
    expect(resolveRootUrl({ method: "GET", path: "/operations/501" })?.toString()).toBe(
      "https://gateway.orbit/api/v1/operations/501",
    );
  });

  it.each([
    { method: "GET", path: "/instances/41/wake" },
    { method: "POST", path: "/instances/41/sleep" },
    { method: "POST", path: "/instances/41/destroy" },
    { method: "POST", path: "/operations/501" },
    { method: "POST", path: "/operations/501/cancel" },
    { method: "GET", path: "/instances/0/wake" },
    { method: "POST", path: "/instances/41/wake/../../nodes" },
    { method: "POST", path: "/conn/instances/41/destroy" },
  ] as const)("refuses $method $path", (request) => {
    expect(resolveRootUrl(request)).toBeNull();
  });

  it("refuses a query on an allowed call", () => {
    expect(
      resolveRootUrl({ method: "GET", path: "/operations/501", query: { include: "steps" } }),
    ).toBeNull();
  });
});
