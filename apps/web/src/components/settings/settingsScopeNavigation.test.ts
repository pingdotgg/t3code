import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsScope, validateSettingsScopeSearch } from "./settingsScope";
import { retainSettingsScope } from "./settingsScopeNavigation";

const checkoutSearch = {
  project: "repository:t3code",
  machine: "remote-server",
  checkout: "remote-server:/home/user/T3 Code",
};

function createSettingsRouter(initialEntry = "/settings/general?scope=device") {
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: (raw: Record<string, unknown>) =>
      validateSettingsScopeSearch(
        typeof raw.environmentId === "string" &&
          raw.machine === undefined &&
          raw.scope === undefined &&
          raw.project === undefined
          ? { ...raw, machine: raw.environmentId }
          : raw,
      ),
    search: { middlewares: [retainSettingsScope] },
    beforeLoad: ({ location }) => {
      if (location.pathname === "/settings") {
        throw redirect({ to: "/settings/general", replace: true });
      }
    },
  });
  const general = createRoute({ getParentRoute: () => settings, path: "general" });
  const projects = createRoute({ getParentRoute: () => settings, path: "projects" });
  const integrations = createRoute({ getParentRoute: () => settings, path: "integrations" });
  const sourceControl = createRoute({ getParentRoute: () => settings, path: "source-control" });
  const providers = createRoute({
    getParentRoute: () => settings,
    path: "providers",
    validateSearch: (raw: Record<string, unknown>) => ({
      ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
        ? { environmentId: EnvironmentId.make(raw.environmentId) }
        : {}),
      ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
        ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
        : {}),
    }),
  });
  const legacyProject = createRoute({
    getParentRoute: () => root,
    path: "projects/$projectKey",
    beforeLoad: ({ params }) => {
      throw redirect({
        to: "/settings/projects",
        search: { project: params.projectKey, machine: undefined },
        replace: true,
      });
    },
  });
  return createRouter({
    routeTree: root.addChildren([
      settings.addChildren([general, projects, integrations, sourceControl, providers]),
      legacyProject,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("settings scope navigation", () => {
  it("replaces device scope with an explicit environment, then replaces it with a project", async () => {
    const router = createSettingsRouter();
    await router.load();
    await router.navigate({
      to: "/settings/general",
      search: { machine: "remote-server" },
      hash: "",
    });
    expect(router.state.location.search).toEqual({ machine: "remote-server" });
    await router.navigate({ to: "/settings/projects", search: { project: "another-project" } });
    expect(router.state.location.search).toEqual({ project: "another-project" });
  });

  it.each(["device", "all"] as const)("clears a checkout when selecting %s", async (scope) => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch, hash: "old-setting" });
    await router.navigate({ to: "/settings/general", search: { scope }, hash: "" });
    expect(router.state.location.search).toEqual({ scope });
    expect(router.state.location.hash).toBe("");
  });

  it("preserves the checkout through category and settings-search navigation", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch, hash: "new-threads" });
    await router.navigate({ to: "/settings/integrations", hash: "", replace: true });
    expect(router.state.location.search).toEqual(checkoutSearch);
    expect(router.state.location.hash).toBe("");
    await router.navigate({ to: "/settings/source-control", hash: "source-control-writing-style" });
    expect(router.state.location.search).toEqual(checkoutSearch);
    expect(router.state.location.hash).toBe("source-control-writing-style");
    await router.navigate({ to: "/settings/projects", hash: "project-defaults" });
    expect(router.state.location.search).toEqual(checkoutSearch);
  });

  it("honors an explicit provider environment and drops its instance on category navigation", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch });
    await router.navigate({
      to: "/settings/providers",
      search: {
        environmentId: EnvironmentId.make("provider-server"),
        instanceId: ProviderInstanceId.make("codex-work"),
      },
    });
    expect(router.state.location.search).toEqual({
      machine: "provider-server",
      environmentId: "provider-server",
      instanceId: "codex-work",
    });
    await router.navigate({ to: "/settings/general", hash: "" });
    expect(router.state.location.search).toEqual({ machine: "provider-server" });
  });

  it("preserves the environment from an initially loaded legacy provider URL", async () => {
    const router = createSettingsRouter(
      "/settings/providers?environmentId=provider-server&instanceId=codex-work",
    );
    await router.load();
    await router.navigate({ to: "/settings/general" });
    expect(router.state.location.search).toEqual({ machine: "provider-server" });
  });

  it("retains an explicit unavailable target rather than reviving the previous environment", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: { machine: "online" } });
    await router.navigate({ to: "/settings/general", search: { machine: "removed" } });
    expect(router.state.location.search).toEqual({ machine: "removed" });
    expect(
      resolveSettingsScope(
        router.state.location.search,
        [],
        [{ environmentId: EnvironmentId.make("online"), label: "Online" }],
      ),
    ).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
      environmentIds: [],
    });
  });

  it("respects explicit clearing keys instead of restoring the previous checkout", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch });
    await router.navigate({
      to: "/settings/projects",
      search: { project: "different-project", machine: undefined },
    });
    expect(router.state.location.search).toEqual({ project: "different-project" });
  });

  it("preserves escaped checkout identifiers across reload and browser history", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch });
    const checkoutHref = router.state.location.href;
    await router.navigate({ to: "/settings/general", search: { machine: "another" } });
    router.history.back();
    await router.load();
    expect(router.state.location.search).toEqual(checkoutSearch);
    const reloaded = createSettingsRouter(checkoutHref);
    await reloaded.load();
    expect(reloaded.state.location.search).toEqual(checkoutSearch);
    await reloaded.navigate({ to: "/settings/integrations", hash: "agent-browser-access" });
    expect(reloaded.state.location.search).toEqual(checkoutSearch);
  });

  it("redirects legacy project links without carrying the prior checkout scope", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch });
    await router.navigate({
      to: "/projects/$projectKey",
      params: { projectKey: "legacy-project" },
    });
    expect(router.state.redirect).not.toBeUndefined();
    await router.navigate(router.state.redirect!.options);
    expect(router.state.location.pathname).toBe("/settings/projects");
    expect(router.state.location.search).toEqual({ project: "legacy-project" });
  });

  it("keeps scope through the settings index redirect", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings", search: { machine: "remote-server" } });
    expect(router.state.redirect).not.toBeUndefined();
    await router.navigate(router.state.redirect!.options);
    expect(router.state.location.pathname).toBe("/settings/general");
    expect(router.state.location.search).toEqual({ machine: "remote-server" });
  });
});
