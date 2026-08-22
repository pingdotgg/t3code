import type { ComponentType, Dispatch, EffectCallback, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  assetStatus: "Success" as "Failure" | "Loading" | "Success",
  lastEnvironmentId: null as unknown,
  lastResource: null as unknown,
  sources: new Map<
    string,
    {
      readonly projectKey: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly faviconPath?: string | null | undefined;
    }
  >(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  let effects: EffectCallback[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
      effects = [];
    },
    commitEffects() {
      const pendingEffects = effects;
      effects = [];
      for (const effect of pendingEffects) effect();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useEffect(effect: EffectCallback) {
      effects.push(effect);
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
    useCallback: <T,>(callback: T) => callback,
    useEffect: hooks.useEffect,
    useState: hooks.useState,
    useSyncExternalStore: (
      _subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.sources,
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../state/projects", () => ({ projectFaviconSourcesAtom: {} }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown) => {
    testState.lastEnvironmentId = environmentId;
    testState.lastResource = resource;
    return testState.assetStatus === "Success"
      ? { _tag: "Success", url: testState.faviconUrl }
      : { _tag: testState.assetStatus };
  },
}));

import {
  forgetProjectFavicon,
  getLoadedProjectFavicon,
} from "@t3tools/client-runtime/state/project-favicon";
import { derivePhysicalProjectKeyFromPath } from "../logicalProject";
import { ProjectFavicon } from "./ProjectFavicon";

type ProjectFaviconImageProps = {
  readonly projectKey: string;
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
    testState.assetStatus = "Success";
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
    testState.lastEnvironmentId = null;
    testState.lastResource = null;
    testState.sources.clear();
    forgetProjectFavicon("repository:pingdotgg/t3code");
    for (const [environmentId, cwd] of [
      ["environment-test", "/workspace-test"],
      ["environment-disconnect", "/workspace-disconnect"],
      ["environment-windows", "C:\\Work\\T3Code\\"],
      ["environment-missing", "/workspace-missing"],
    ] as const) {
      forgetProjectFavicon(derivePhysicalProjectKeyFromPath(environmentId, cwd));
    }
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
      faviconPath: "brand/icon.svg",
    });

    expect(testState.lastResource).toEqual({
      _tag: "project-favicon",
      cwd: "/workspace-test",
      path: "brand/icon.svg",
    });
  });

  it("requests the selected group source instead of the row's environment", () => {
    const environmentId = "environment-sibling" as EnvironmentId;
    const cwd = "/workspace/sibling";
    testState.sources.set(derivePhysicalProjectKeyFromPath(environmentId, cwd), {
      projectKey: "repository:pingdotgg/t3code",
      environmentId: "environment-source" as EnvironmentId,
      cwd: "/workspace/source",
      faviconPath: "brand/icon.svg",
    });

    ProjectFavicon({ environmentId, cwd, faviconPath: "ignored.svg" });

    expect(testState.lastEnvironmentId).toBe("environment-source");
    expect(testState.lastResource).toEqual({
      _tag: "project-favicon",
      cwd: "/workspace/source",
      path: "brand/icon.svg",
    });
  });

  it("keeps the last loaded favicon while its environment is disconnected", () => {
    const environmentId = "environment-disconnect" as EnvironmentId;
    const cwd = "/workspace-disconnect";
    hooks.beginRender();
    const loadedElement = ProjectFavicon({
      environmentId,
      cwd,
    }) as ReactElement<ProjectFaviconImageProps>;
    hooks.reset();

    const ImageComponent = loadedElement.type as (
      props: ProjectFaviconImageProps,
    ) => ProjectFaviconImageElement;
    const loadingImage = renderImage(ImageComponent, loadedElement.props).props.children[2];
    loadingImage?.props.onLoad?.();

    testState.assetStatus = "Loading";
    hooks.beginRender();
    const disconnectedElement = ProjectFavicon({
      environmentId,
      cwd,
    }) as ReactElement<ProjectFaviconImageProps>;

    expect(disconnectedElement.props.src).toBe(testState.faviconUrl);
    expect(disconnectedElement.props.cacheKey).toBe(loadedElement.props.cacheKey);
  });

  it("shares one loaded favicon across members of a logical project group", () => {
    const projectKey = "repository:pingdotgg/t3code";
    const source = {
      projectKey,
      environmentId: "environment-source" as EnvironmentId,
      cwd: "/workspace/source",
    };
    testState.sources.set(
      derivePhysicalProjectKeyFromPath(source.environmentId, source.cwd),
      source,
    );
    testState.sources.set(
      derivePhysicalProjectKeyFromPath("environment-sibling", "/different/workspace"),
      source,
    );
    hooks.beginRender();
    const loadedElement = ProjectFavicon({
      environmentId: "environment-source" as EnvironmentId,
      cwd: "/workspace/source",
    }) as ReactElement<ProjectFaviconImageProps>;
    hooks.reset();

    const ImageComponent = loadedElement.type as (
      props: ProjectFaviconImageProps,
    ) => ProjectFaviconImageElement;
    renderImage(ImageComponent, loadedElement.props).props.children[2]?.props.onLoad?.();

    testState.assetStatus = "Loading";
    hooks.beginRender();
    const siblingElement = ProjectFavicon({
      environmentId: "environment-sibling" as EnvironmentId,
      cwd: "/different/workspace",
    }) as ReactElement<ProjectFaviconImageProps>;

    expect(siblingElement.props.src).toBe(testState.faviconUrl);
  });

  it("normalizes physical project keys", () => {
    const environmentId = "environment-windows" as EnvironmentId;
    hooks.beginRender();
    const loadedElement = ProjectFavicon({
      environmentId,
      cwd: "C:\\Work\\T3Code\\",
    }) as ReactElement<ProjectFaviconImageProps>;
    hooks.reset();

    const ImageComponent = loadedElement.type as (
      props: ProjectFaviconImageProps,
    ) => ProjectFaviconImageElement;
    renderImage(ImageComponent, loadedElement.props).props.children[2]?.props.onLoad?.();

    testState.assetStatus = "Loading";
    hooks.beginRender();
    const normalizedElement = ProjectFavicon({
      environmentId,
      cwd: "c:/work/t3code",
    }) as ReactElement<ProjectFaviconImageProps>;

    expect(normalizedElement.props.src).toBe(testState.faviconUrl);
  });

  it("forgets the loaded favicon when the environment confirms it is missing", () => {
    const environmentId = "environment-missing" as EnvironmentId;
    const cwd = "/workspace-missing";
    const projectKey = derivePhysicalProjectKeyFromPath(environmentId, cwd);
    hooks.beginRender();
    const loadedElement = ProjectFavicon({
      environmentId,
      cwd,
    }) as ReactElement<ProjectFaviconImageProps>;
    hooks.reset();

    const ImageComponent = loadedElement.type as (
      props: ProjectFaviconImageProps,
    ) => ProjectFaviconImageElement;
    renderImage(ImageComponent, loadedElement.props).props.children[2]?.props.onLoad?.();

    testState.faviconUrl =
      "https://environment.test/api/assets/token-missing/project-favicon-missing";
    hooks.beginRender();
    const missingElement = ProjectFavicon({ environmentId, cwd });

    expect(getLoadedProjectFavicon(projectKey)?.src).toBe(loadedElement.props.src);
    expect(missingElement.type).not.toBe(loadedElement.type);
    hooks.commitEffects();
    expect(getLoadedProjectFavicon(projectKey)).toBeNull();

    testState.assetStatus = "Loading";
    hooks.beginRender();
    const disconnectedElement = ProjectFavicon({ environmentId, cwd });

    expect(disconnectedElement.type).toBe(missingElement.type);
    expect(disconnectedElement.type).not.toBe(loadedElement.type);
  });
});
