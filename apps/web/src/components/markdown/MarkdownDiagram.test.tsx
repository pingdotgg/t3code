import { act, type ComponentProps, type ReactNode } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { fromSource } from "@likec4/language-services/browser";
import ChatMarkdown from "../ChatMarkdown";
import {
  getDiagramDisplayName,
  getDiagramType,
  isDiagramLanguage,
  isLikeC4Language,
  isMermaidLanguage,
} from "./diagramUtils";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

describe("diagramUtils", () => {
  it("correctly identifies Mermaid languages", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage("MERMAID")).toBe(true);
    expect(isMermaidLanguage(" mermaid ")).toBe(true);
    expect(isMermaidLanguage("typescript")).toBe(false);
    expect(isMermaidLanguage("")).toBe(false);
    expect(isMermaidLanguage(null)).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
  });

  it("correctly identifies LikeC4 languages", () => {
    expect(isLikeC4Language("likec4")).toBe(true);
    expect(isLikeC4Language("like-c4")).toBe(true);
    expect(isLikeC4Language("c4")).toBe(true);
    expect(isLikeC4Language("LIKEC4")).toBe(true);
    expect(isLikeC4Language(" likec4 ")).toBe(true);
    expect(isLikeC4Language("javascript")).toBe(false);
    expect(isLikeC4Language("")).toBe(false);
    expect(isLikeC4Language(null)).toBe(false);
    expect(isLikeC4Language(undefined)).toBe(false);
  });

  it("correctly identifies any diagram language", () => {
    expect(isDiagramLanguage("mermaid")).toBe(true);
    expect(isDiagramLanguage("likec4")).toBe(true);
    expect(isDiagramLanguage("like-c4")).toBe(true);
    expect(isDiagramLanguage("c4")).toBe(true);
    expect(isDiagramLanguage("python")).toBe(false);
    expect(isDiagramLanguage(null)).toBe(false);
  });

  it("returns proper diagram type and display names", () => {
    expect(getDiagramType("mermaid")).toBe("mermaid");
    expect(getDiagramType("likec4")).toBe("likec4");
    expect(getDiagramType("like-c4")).toBe("likec4");
    expect(getDiagramType("c4")).toBe("likec4");
    expect(getDiagramType("rust")).toBe(null);

    expect(getDiagramDisplayName("mermaid")).toBe("Mermaid Diagram");
    expect(getDiagramDisplayName("likec4")).toBe("LikeC4 Diagram");
    expect(getDiagramDisplayName("c4")).toBe("LikeC4 Diagram");
  });
});

describe("LikeC4 DSL compilation", () => {
  it("successfully parses LikeC4 DSL and generates layouted views", async () => {
    const dsl = `
specification {
  element user
  element system
}
model {
  u = user 'End User'
  s = system 'Main System'
  u -> s 'Uses'
}
views {
  view index {
    include *
  }
}
`;
    const likec4 = await fromSource(dsl);
    expect(likec4.hasErrors()).toBe(false);

    const model = await likec4.layoutedModel();
    const views = [...model.views()];
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(views.some((v) => v.id === "index")).toBe(true);
  });

  it("identifies errors for invalid LikeC4 DSL", async () => {
    const badDsl = `
model {
  broken unknownElement
}
`;
    const likec4 = await fromSource(badDsl);
    expect(likec4.hasErrors()).toBe(true);
    const errors = likec4.getErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("Could not resolve reference");
  });
});

describe("ChatMarkdown Diagram rendering", () => {
  it("renders a diagram block for mermaid fenced code blocks", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const text = "```mermaid\ngraph TD\n  A[Start] --> B[End]\n```";
    let testRenderer: ReturnType<typeof create> | undefined;

    act(() => {
      testRenderer = create(<ChatMarkdown cwd="/tmp/project" text={text} />);
    });

    const root = testRenderer!.root;
    const diagramBlock = root.find((node) => node.props["data-diagram-type"] === "mermaid");

    expect(diagramBlock).toBeDefined();
    expect(diagramBlock.props["data-language"]).toBe("mermaid");
    expect(diagramBlock.props["data-view-mode"]).toBe("diagram");

    const textNodes = diagramBlock.findAll((node) => typeof node.props.children === "string");
    const fullText = textNodes.map((n) => n.props.children).join(" ");
    expect(fullText).toContain("Mermaid Diagram");
  });

  it("renders a diagram block for likec4, like-c4, and c4 fenced code blocks", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    for (const lang of ["likec4", "like-c4", "c4"]) {
      const text = `\`\`\`${lang}\nspecification {\n  element component\n}\nmodel {\n  c = component\n}\n\`\`\``;
      let testRenderer: ReturnType<typeof create> | undefined;

      act(() => {
        testRenderer = create(<ChatMarkdown cwd="/tmp/project" text={text} />);
      });

      const root = testRenderer!.root;
      const diagramBlock = root.find((node) => node.props["data-diagram-type"] === "likec4");

      expect(diagramBlock).toBeDefined();
      expect(diagramBlock.props["data-language"]).toBe(lang);
      expect(diagramBlock.props["data-view-mode"]).toBe("diagram");
    }
  });

  it("respects custom fence title in diagram header", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const text = '```mermaid title="User Authentication Flow"\ngraph LR\n  A --> B\n```';
    let testRenderer: ReturnType<typeof create> | undefined;

    act(() => {
      testRenderer = create(<ChatMarkdown cwd="/tmp/project" text={text} />);
    });

    const root = testRenderer!.root;
    const diagramBlock = root.find((node) => node.props["data-diagram-type"] === "mermaid");

    expect(diagramBlock).toBeDefined();
    const textNodes = diagramBlock.findAll((node) => typeof node.props.children === "string");
    const fullText = textNodes.map((n) => n.props.children).join(" ");
    expect(fullText).toContain("User Authentication Flow");
  });

  it("does not treat regular code fences as diagram blocks", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const text = "```typescript\nconst x = 42;\n```";
    let testRenderer: ReturnType<typeof create> | undefined;

    act(() => {
      testRenderer = create(<ChatMarkdown cwd="/tmp/project" text={text} />);
    });

    const root = testRenderer!.root;
    const diagramBlocks = root.findAll((node) => Boolean(node.props["data-diagram-type"]));

    expect(diagramBlocks.length).toBe(0);
  });
});
