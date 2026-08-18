import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetMermaidRenderingForTests,
  __setMermaidLoaderForTests,
  isMermaidFenceLanguage,
  mermaidSourceAsMarkdownFence,
  prepareMermaidOverlaySvg,
  remapMermaidSvgIds,
  renderMermaidSvg,
  sanitizeMermaidSvg,
  type MermaidRuntime,
} from "./mermaidRendering";

function fakeRuntime(overrides: Partial<MermaidRuntime> = {}): MermaidRuntime {
  return {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: "<svg>ok</svg>" })),
    ...overrides,
  };
}

describe("isMermaidFenceLanguage", () => {
  it("accepts mermaid and the mmd alias, ignoring case", () => {
    expect(isMermaidFenceLanguage("mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("MERMAID")).toBe(true);
    expect(isMermaidFenceLanguage(" mmd ")).toBe(true);
  });

  it("rejects ordinary fence languages", () => {
    expect(isMermaidFenceLanguage("ts")).toBe(false);
    expect(isMermaidFenceLanguage("text")).toBe(false);
    expect(isMermaidFenceLanguage(undefined)).toBe(false);
  });
});

describe("mermaidSourceAsMarkdownFence", () => {
  it("wraps source in a mermaid fence", () => {
    expect(mermaidSourceAsMarkdownFence("graph TD\n  A --> B\n")).toBe(
      "```mermaid\ngraph TD\n  A --> B\n```",
    );
  });

  it("lengthens the fence when the source contains backticks", () => {
    expect(mermaidSourceAsMarkdownFence("graph TD\n  A[```]\n")).toBe(
      "````mermaid\ngraph TD\n  A[```]\n````",
    );
  });
});

describe("sanitizeMermaidSvg", () => {
  it("strips script tags, event handlers, and javascript hrefs", () => {
    const dirty = `<svg><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(1)">x</a><script src="x.js"/></svg>`;
    expect(sanitizeMermaidSvg(dirty)).toBe(`<svg><a>x</a></svg>`);
  });

  it("leaves mermaid marker urls and ordinary attributes alone", () => {
    const svg = `<svg><path marker-end="url(#arrow)" class="edge" /></svg>`;
    expect(sanitizeMermaidSvg(svg)).toBe(svg);
  });
});

describe("remapMermaidSvgIds", () => {
  it("suffixes ids and url/href references so overlay clones do not collide", () => {
    const svg = `<svg id="t3-mermaid-1"><defs><marker id="arrow" /></defs><path marker-end="url(#arrow)" href="#arrow" xlink:href="#arrow" /></svg>`;
    expect(remapMermaidSvgIds(svg, "-ov")).toBe(
      `<svg id="t3-mermaid-1-ov"><defs><marker id="arrow-ov" /></defs><path marker-end="url(#arrow-ov)" href="#arrow-ov" xlink:href="#arrow-ov" /></svg>`,
    );
  });

  it("rewrites longer ids first so prefixes are not partially replaced", () => {
    const svg = `<svg id="flowchart" ><g id="flowchart-A" /></svg>`;
    expect(remapMermaidSvgIds(svg, "-x")).toBe(
      `<svg id="flowchart-x" ><g id="flowchart-A-x" /></svg>`,
    );
  });

  it("rewrites mermaid theme selectors so overlay labels keep their colors", () => {
    const svg = `<svg id="t3-mermaid-1"><style>#t3-mermaid-1{fill:#1a1a1a;}#t3-mermaid-1 .nodeLabel{color:#ccc;}</style></svg>`;
    expect(remapMermaidSvgIds(svg, "-ov")).toBe(
      `<svg id="t3-mermaid-1-ov"><style>#t3-mermaid-1-ov{fill:#1a1a1a;}#t3-mermaid-1-ov .nodeLabel{color:#ccc;}</style></svg>`,
    );
  });
});

describe("prepareMermaidOverlaySvg", () => {
  it("pins intrinsic width/height and drops mermaid's shrink-to-fit sizing", () => {
    const svg = `<svg id="t3-mermaid-1" width="100%" viewBox="0 0 240 80" style="max-width: 240px; background: white;"></svg>`;
    expect(prepareMermaidOverlaySvg(svg, "-ov")).toBe(
      `<svg width="240" height="80" id="t3-mermaid-1-ov" viewBox="0 0 240 80" style="background: white"></svg>`,
    );
  });
});

describe("renderMermaidSvg", () => {
  afterEach(() => {
    __resetMermaidRenderingForTests();
  });

  it("initializes mermaid in strict mode and caches the sanitized svg", async () => {
    const runtime = fakeRuntime({
      render: vi.fn(async () => ({
        svg: `<svg onclick="alert(1)">ok</svg>`,
      })),
    });
    __setMermaidLoaderForTests(async () => runtime);

    const first = await renderMermaidSvg("graph TD; A-->B;", "dark");
    const second = await renderMermaidSvg("graph TD; A-->B;", "dark");

    expect(first).toBe("<svg>ok</svg>");
    expect(second).toBe(first);
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(runtime.render).toHaveBeenCalledTimes(1);
    expect(runtime.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: "dark",
      }),
    );
    const config = (runtime.initialize as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      secure: string[];
    };
    expect(config.secure).toContain("securityLevel");
  });

  it("serializes concurrent renders so mermaid's global config cannot race", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = fakeRuntime({
      render: vi.fn(async (id: string) => {
        order.push(`start:${id}`);
        if (id === "t3-mermaid-1") await firstGate;
        order.push(`end:${id}`);
        return { svg: `<svg>${id}</svg>` };
      }),
    });
    __setMermaidLoaderForTests(async () => runtime);

    const first = renderMermaidSvg("graph TD; A-->B;", "light");
    const second = renderMermaidSvg("graph TD; A-->C;", "light");
    await vi.waitFor(() => {
      expect(order).toEqual(["start:t3-mermaid-1"]);
    });
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "start:t3-mermaid-1",
      "end:t3-mermaid-1",
      "start:t3-mermaid-2",
      "end:t3-mermaid-2",
    ]);
  });

  it("wraps parse failures so callers can fall back to the source", async () => {
    const runtime = fakeRuntime({
      parse: vi.fn(async () => {
        throw new Error("Parse error on line 2");
      }),
    });
    __setMermaidLoaderForTests(async () => runtime);

    await expect(renderMermaidSvg("not a diagram", "light")).rejects.toThrow(
      "Parse error on line 2",
    );
    expect(runtime.render).not.toHaveBeenCalled();
  });

  it("retries loading mermaid after a failed import", async () => {
    let attempts = 0;
    __setMermaidLoaderForTests(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk failed");
      return fakeRuntime();
    });

    await expect(renderMermaidSvg("graph TD; A-->B;", "light")).rejects.toThrow("chunk failed");
    await expect(renderMermaidSvg("graph TD; A-->B;", "light")).resolves.toBe("<svg>ok</svg>");
    expect(attempts).toBe(2);
  });
});
