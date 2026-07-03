import { describe, expect, it } from "vite-plus/test";

import {
  Button,
  ChatMarkdown,
  ProviderModelPicker,
  TraitsPicker,
  createPluginAtoms,
  defineWebPlugin,
  hostCompat,
  pluginSdkWebExternalDependencies,
} from "./index";

describe("plugin-sdk-web", () => {
  it("re-exports the host web surface", () => {
    expect(typeof Button).toBe("function");
    expect(typeof ChatMarkdown).toBe("object");
    expect(typeof ProviderModelPicker).toBe("object");
    expect(typeof TraitsPicker).toBe("object");
    expect(typeof createPluginAtoms).toBe("function");
    expect(hostCompat.hostApiVersion).toBe("1.0.0");
  });

  it("keeps host singleton dependencies external for plugin builds", () => {
    expect(pluginSdkWebExternalDependencies).toEqual(
      expect.arrayContaining(["@effect/atom-react", "effect", "react", "react-dom"]),
    );
  });

  it("returns defineWebPlugin definitions unchanged", () => {
    const definition = defineWebPlugin({
      register(ctx) {
        ctx.registerRoute({
          path: "overview",
          component: () => null,
        });
        ctx.registerSidebarSection({
          id: "main",
          title: "Main",
          render: () => null,
        });
        ctx.registerSettingsPage({
          id: "settings",
          title: "Settings",
          component: () => null,
        });
        ctx.registerCommand({
          id: "refresh",
          title: "Refresh",
          run: () => undefined,
        });
      },
    });

    expect(typeof definition.register).toBe("function");
  });
});
