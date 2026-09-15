import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastTarget: null as unknown,
  projectMonogramColor: "auto",
}));

vi.mock("lucide-react/dynamic", () => ({
  DynamicIcon: (props: { name: string; className: string }) => (
    <span data-testid="dynamic-icon" {...props} />
  ),
  iconNames: ["alarm-clock", "folder-code"],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.faviconUrl,
}));
vi.mock("../state/assets", () => ({
  projectFaviconUrlAtom: (input: unknown) => {
    testState.lastTarget = input;
  },
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (selector?: (settings: { projectMonogramColor: string }) => unknown) => {
    const settings = { projectMonogramColor: testState.projectMonogramColor };
    return selector ? selector(settings) : settings;
  },
}));

import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

let renderer: ReactTestRenderer | undefined;

function makeProject(
  overrides: Partial<ProjectFaviconProject> &
    Pick<ProjectFaviconProject, "workspaceRoot" | "title">,
): ProjectFaviconProject {
  return { environmentId: "environment-test" as EnvironmentId, ...overrides };
}

async function renderProject(project: ProjectFaviconProject) {
  if (renderer) {
    await act(() => renderer?.unmount());
  }
  await act(() => {
    renderer = create(<ProjectFavicon project={project} />);
  });
  const rendered = renderer;
  if (!rendered) throw new Error("Project favicon renderer was not created");
  return rendered;
}

async function renderMissingImageMonogram(title: string) {
  testState.faviconUrl = `https://environment.test/api/assets/token/${PROJECT_FAVICON_FALLBACK_MARKER}`;
  const rendered = await renderProject(
    makeProject({ workspaceRoot: "/workspace/monogram", title }),
  );
  const svg = rendered.root.findByType("svg");
  const text = rendered.root.findByType("text");
  return {
    backgroundColor: svg.props.style?.backgroundColor,
    backgroundImage: svg.props.style?.backgroundImage,
    fill: text.props.fill,
    glyph: text.children.join(""),
  };
}

describe("ProjectFavicon", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
    testState.projectMonogramColor = "auto";
  });

  afterEach(async () => {
    if (renderer) {
      await act(() => renderer?.unmount());
      renderer = undefined;
    }
    vi.unstubAllGlobals();
  });

  it("shows the project monogram when no favicon exists", async () => {
    const monogram = await renderMissingImageMonogram("analytics-db");

    expect(monogram.glyph).toMatch(/[A-Z]/);
  });

  it("uses the same monogram fallback for every project category", async () => {
    const monogram = await renderMissingImageMonogram("agent-runtime");

    expect(monogram.glyph).toMatch(/[A-Z]/);
  });

  it("renders a saved Lucide icon and color ahead of an uploaded favicon", async () => {
    const rendered = await renderProject(
      makeProject({
        workspaceRoot: "/workspace/test",
        title: "test",
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
      }),
    );

    const icon = rendered.root
      .findAllByType("span")
      .find((span) => span.props["data-testid"] === "dynamic-icon");
    if (!icon) throw new Error("Dynamic project icon was not rendered");
    expect(icon.props.name).toBe("alarm-clock");
    expect(rendered.root.findByType("span").props.className).toContain("text-violet-600");
    expect(icon.props.className).toContain("text-violet-600");
  });

  it("renders a saved emoji ahead of an uploaded favicon", async () => {
    const rendered = await renderProject(
      makeProject({
        workspaceRoot: "/workspace/test",
        title: "test",
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "emoji", emoji: "🦄" },
      }),
    );

    expect(rendered.root.findAllByType("span").some((span) => span.children.includes("🦄"))).toBe(
      true,
    );
  });

  it("falls back when the displayed favicon fails without discarding a valid older image early", async () => {
    const project = makeProject({
      workspaceRoot: "/workspace-test",
      title: "workspace-test",
      faviconPath: "brand/icon.svg",
    });
    const initialSrc = testState.faviconUrl;
    const refreshedSrc = "https://environment.test/api/assets/token-b/v1-20-favicon.svg";
    const rendered = await renderProject(project);

    const initialLoadingImage = rendered.root.findAllByType("img")[0];
    if (!initialLoadingImage) throw new Error("Initial favicon image was not rendered");
    await act(() => initialLoadingImage.props.onLoad());

    testState.faviconUrl = refreshedSrc;
    await act(() => {
      renderer?.update(<ProjectFavicon project={project} />);
    });

    expect(
      rendered.root.findAllByType("img").filter((image) => image.props.src === initialSrc),
    ).toHaveLength(1);
    const refreshingImage = rendered.root
      .findAllByType("img")
      .find((image) => image.props.src === refreshedSrc);
    if (!refreshingImage) throw new Error("Refreshed favicon image was not rendered");
    await act(() => refreshingImage.props.onError());
    expect(
      rendered.root.findAllByType("img").filter((image) => image.props.src === initialSrc),
    ).toHaveLength(1);

    const displayedImage = rendered.root
      .findAllByType("img")
      .find((image) => image.props.src === initialSrc);
    if (!displayedImage) throw new Error("Displayed favicon image was not rendered");
    await act(() => displayedImage.props.onError());
    expect(rendered.root.findByType("svg")).toBeDefined();
    expect(
      rendered.root.findAllByType("img").filter((image) => image.props.src === initialSrc),
    ).toHaveLength(0);
  });

  it("requests a saved favicon path when one is set", async () => {
    await renderProject(
      makeProject({
        workspaceRoot: "/workspace-test",
        title: "workspace-test",
        faviconPath: "brand/icon.svg",
      }),
    );

    expect(testState.lastTarget).toMatchObject({
      environmentId: "environment-test",
      cwd: "/workspace-test",
      faviconPath: "brand/icon.svg",
    });
  });

  it("uses the project color and current color for missing favicons in automatic mode", async () => {
    testState.projectMonogramColor = "auto";
    const monogram = await renderMissingImageMonogram("analytics-db");

    expect(monogram.backgroundColor).toContain("color-mix");
    expect(monogram.fill).toBe("currentColor");
  });

  it("uses the theme action color for missing favicons in accent mode", async () => {
    testState.projectMonogramColor = "accent";
    const monogram = await renderMissingImageMonogram("analytics-db");

    expect(monogram.backgroundColor).toBe("var(--primary)");
    expect(monogram.fill).toBe("var(--primary-foreground)");
  });

  it("keeps the same monogram glyph in both color modes", async () => {
    testState.projectMonogramColor = "auto";
    const automatic = await renderMissingImageMonogram("analytics-db");
    testState.projectMonogramColor = "accent";
    const accent = await renderMissingImageMonogram("analytics-db");

    expect(accent.glyph).toBe(automatic.glyph);
  });

  it("uses the theme action color for failed favicons in accent mode", async () => {
    testState.projectMonogramColor = "accent";
    const rendered = await renderProject(
      makeProject({
        workspaceRoot: "/workspace-test",
        title: "workspace-test",
        faviconPath: "brand/icon.svg",
      }),
    );

    const loadingImage = rendered.root.findAllByType("img")[0];
    if (!loadingImage) throw new Error("Initial favicon image was not rendered");
    await act(() => loadingImage.props.onLoad());
    const displayedImage = rendered.root.findByType("img");
    await act(() => displayedImage.props.onError());

    const monogram = rendered.root.findByType("svg");
    const glyph = rendered.root.findByType("text");
    expect(monogram.props.style?.backgroundColor).toBe("var(--primary)");
    expect(glyph.props.fill).toBe("var(--primary-foreground)");
  });
});
