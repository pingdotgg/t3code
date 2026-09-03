import type { ComponentType, Dispatch, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastResource: null as unknown,
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("lucide-react/dynamic", () => ({
  DynamicIcon: "dynamic-icon",
  iconNames: ["alarm-clock", "folder-code"],
}));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.lastResource = resource;
    return { _tag: "Success", url: testState.faviconUrl };
  },
}));

import { ProjectFavicon } from "./ProjectFavicon";

type ProjectFaviconImageProps = {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
};

type ImageElement = ReactElement<{
  readonly src: string;
  readonly onLoad?: () => void;
  readonly onError?: () => void;
}>;

type ProjectFaviconImageElement = ReactElement<{
  readonly children: [ReactElement | null, ImageElement | null, ImageElement | null];
}>;

function resolveImageComponent(): {
  readonly Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement;
  readonly props: ProjectFaviconImageProps;
} {
  hooks.beginRender();
  const element = ProjectFavicon({
    environmentId: "environment-test" as EnvironmentId,
    cwd: "/workspace-test",
    projectName: "workspace-test",
  }) as ReactElement<ProjectFaviconImageProps>;
  hooks.reset();

  return {
    Component: element.type as (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
    props: element.props,
  };
}

function renderImage(
  Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
  props: ProjectFaviconImageProps,
): ProjectFaviconImageElement {
  hooks.beginRender();
  return Component(props);
}

describe("ProjectFavicon", () => {
  beforeEach(() => {
    hooks.reset();
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
  });

  it("shows a project-name emoji when no favicon exists", () => {
    testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;

    const element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace/analytics-db",
      projectName: "analytics-db",
    }) as ReactElement<{ readonly emoji?: string }>;

    expect(element.props.emoji).toBe("🗄️");
  });

  it("chooses a deterministic semantic emoji", () => {
    testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;

    const element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace/agent-runtime",
      projectName: "agent-runtime",
    }) as ReactElement<{ readonly emoji?: string }>;

    expect(element.props.emoji).toBe("🤖");
  });

  it("renders a saved Lucide icon and color ahead of an uploaded favicon", () => {
    const element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace/test",
      projectName: "test",
      faviconPath: "brand/icon.svg",
      projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
    }) as ReactElement<{
      readonly children: ReactElement<{
        readonly children: ReactElement<{ readonly name: string; readonly className: string }>;
      }>;
      readonly className: string;
    }>;

    expect(element.props.children.props.children.props.name).toBe("alarm-clock");
    expect(element.props.className).toContain("text-violet-600");
    expect(element.props.children.props.children.props.className).toContain("text-violet-600");
  });

  it("renders a saved emoji ahead of an uploaded favicon", () => {
    const element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace/test",
      projectName: "test",
      faviconPath: "brand/icon.svg",
      projectIcon: { kind: "emoji", emoji: "🦄" },
    }) as ReactElement<{ readonly emoji: string }>;

    expect(element.props.emoji).toBe("🦄");
  });

  it("falls back when the displayed favicon fails without discarding a valid older image early", () => {
    const { Component, props } = resolveImageComponent();
    const initialLoadingImage = renderImage(Component, props).props.children[2];
    initialLoadingImage?.props.onLoad?.();

    const refreshedProps = {
      ...props,
      src: "https://environment.test/api/assets/token-b/v1-20-favicon.svg",
    };
    const refreshing = renderImage(Component, refreshedProps).props.children;
    expect(refreshing[1]?.props.src).toBe(props.src);
    refreshing[2]?.props.onError?.();

    const afterRefreshError = renderImage(Component, refreshedProps).props.children;
    expect(afterRefreshError[1]?.props.src).toBe(props.src);
    afterRefreshError[1]?.props.onError?.();

    const afterDisplayedError = renderImage(Component, refreshedProps).props.children;
    expect(afterDisplayedError[0]).not.toBeNull();
    expect(afterDisplayedError[1]).toBeNull();
  });

  it("requests a saved favicon path when one is set", () => {
    ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace-test",
      projectName: "workspace-test",
      faviconPath: "brand/icon.svg",
    });

    expect(testState.lastResource).toEqual({
      _tag: "project-favicon",
      cwd: "/workspace-test",
      path: "brand/icon.svg",
    });
  });
});
