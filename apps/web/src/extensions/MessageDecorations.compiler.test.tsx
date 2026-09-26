import source from "./MessageDecorations.tsx?raw";
import * as NodeModule from "node:module";
import { transformWithOxc } from "vite";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import * as React from "react";
import * as CompilerRuntime from "react/compiler-runtime";
import * as JSXRuntime from "react/jsx-runtime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import * as registry from "./workspaceRegistry";
import type { MessageDecorations } from "./MessageDecorations";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("compiler output observes installation after a message mounts without extensions", async () => {
  const require = NodeModule.createRequire(import.meta.resolve("@rolldown/plugin-babel"));
  const babel = require("@babel/core") as typeof import("@babel/core");
  const compiled = babel.transformSync(source, {
    filename: "MessageDecorations.tsx",
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [reactCompilerPreset().preset],
    configFile: false,
    babelrc: false,
  })!.code!;
  expect(compiled).toContain("react/compiler-runtime");
  const transformed = await transformWithOxc(compiled, "MessageDecorations.tsx", {
    jsx: { runtime: "automatic" },
  });
  const imports: string[] = [];
  const body = transformed.code
    .replace(
      /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?/g,
      (_, bindings: string, name: string) => {
        imports.push(
          "const { " +
            bindings.replace(/\bas\b/g, ":") +
            " } = modules[" +
            JSON.stringify(name) +
            "];",
        );
        return "";
      },
    )
    .replace(/export\s*\{[^}]+\};?/g, "")
    .replace("export function MessageDecorations", "function MessageDecorations");
  const Compiled = new Function(
    "modules",
    imports.join("\n") + "\n" + body + "\nreturn MessageDecorations;",
  )({
    react: React,
    "react/compiler-runtime": CompilerRuntime,
    "react/jsx-runtime": JSXRuntime,
    "../env": { isElectron: false },
    "./workspaceRegistry": registry,
  }) as typeof MessageDecorations;
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  let root!: ReactTestRenderer;
  let unregister = () => {};
  const decorate = vi.fn(() => ({ title: "Installed card", text: "Original remains readable" }));
  const install = () =>
    registry.registerWorkspaceExtension({
      manifest: {
        id: "test.compiler",
        apiVersion: 1,
        version: "1.0.0",
        surfaces: [],
        messageDecorations: [{ id: "test.compiler/card", title: "Card", clients: ["web"] }],
      },
      surfaces: [],
      messageDecorations: [{ id: "test.compiler/card", decorate }],
    });
  try {
    await act(async () => {
      root = create(
        <Compiled
          message={{
            environmentId: "env",
            threadId: "thread",
            messageId: "message",
            text: "persisted",
          }}
        />,
        { createNodeMock: () => ({}) },
      );
    });
    expect(callbacks).toHaveLength(0);
    await act(async () => {
      unregister = install();
    });
    expect(callbacks).toHaveLength(1);
    expect(decorate).not.toHaveBeenCalled();
    await act(async () => {
      callbacks[0]!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(root.root.findAllByType("aside")).toHaveLength(1);
    await act(async () => {
      unregister();
    });
    expect(root.root.findAllByType("aside")).toHaveLength(0);
    await act(async () => {
      unregister = install();
    });
    expect(callbacks).toHaveLength(2);
    await act(async () => {
      callbacks[0]!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(root.root.findAllByType("aside")).toHaveLength(0);
    await act(async () => {
      callbacks[1]!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(root.root.findAllByType("aside")).toHaveLength(1);
  } finally {
    await act(async () => {
      root?.unmount();
      unregister();
    });
    vi.unstubAllGlobals();
  }
});
