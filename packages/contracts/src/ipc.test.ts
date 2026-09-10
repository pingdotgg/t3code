import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPreviewDesignChangePayloadSchema,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("DesktopPreviewDesignChangePayloadSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopPreviewDesignChangePayloadSchema);

  it("keeps an attached design element with the saved document", () => {
    const annotation = {
      id: "design-cta",
      pageUrl: "http://127.0.0.1:3773/api/assets/design",
      pageTitle: "Landing page",
      comment: "Selected design element",
      elements: [
        {
          id: "cta",
          element: {
            pageUrl: "http://127.0.0.1:3773/api/assets/design",
            pageTitle: "Landing page",
            tagName: "button",
            selector: '[data-t3-design-id="cta"]',
            htmlPreview: '<button data-t3-design-id="cta">Start</button>',
            componentName: null,
            source: null,
            stack: [],
            styles: "background-color: #111111;",
            pickedAt: "2026-08-18T00:00:00.000Z",
          },
          rect: { x: 20, y: 30, width: 120, height: 40 },
        },
      ],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-08-18T00:00:00.000Z",
    };

    expect(decode({ html: "<!doctype html><button>Start</button>", annotation })).toEqual({
      html: "<!doctype html><button>Start</button>",
      annotation,
    });
  });

  it("accepts large generated designs", () => {
    const html = "x".repeat(5_000_001);

    expect(decode({ html }).html).toHaveLength(html.length);
  });
});
