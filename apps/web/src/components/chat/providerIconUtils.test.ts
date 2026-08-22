import { ProviderDriverKind } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { OpenCode2Icon, OpenCodeIcon } from "../Icons";
import {
  DRIVER_OPTION_BY_VALUE,
  PROVIDER_CLIENT_DEFINITIONS,
} from "../settings/providerDriverMeta";
import {
  PROVIDER_ICON_BY_PROVIDER,
  resolveProviderModelPickerAriaLabel,
} from "./providerIconUtils";

describe("OpenCode provider icons", () => {
  it("uses a distinct icon component for OpenCode 2 in chat and settings surfaces", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("opencode")]).toBe(OpenCodeIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("opencode2")]).toBe(OpenCode2Icon);
    expect(DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode2")]?.icon).toBe(OpenCode2Icon);
  });

  it("keeps chat and settings icon registries aligned", () => {
    for (const definition of PROVIDER_CLIENT_DEFINITIONS) {
      expect(PROVIDER_ICON_BY_PROVIDER[definition.value]).toBe(definition.icon);
    }
  });

  it("uses the official dev icon's blue inner treatment for OpenCode 2", () => {
    const opencode = renderToStaticMarkup(createElement(OpenCodeIcon));
    const opencode2 = renderToStaticMarkup(createElement(OpenCode2Icon));

    expect(opencode).toContain('d="M24 32H8V16H24V32Z" fill="#CFCECD"');
    expect(opencode2).toContain('d="M24 32H8V8H24V32Z" fill="#2E6CE9"');
    expect(opencode2).toContain('d="M24 11H8V8H24V11Z" fill="#82C4FF"');
    expect(opencode2).toContain('d="M24 32H8V29H24V32Z" fill="#0A2055"');
    expect(opencode2).toContain('class="dark:hidden"');
    expect(opencode2).toContain('class="hidden dark:block"');
  });

  it("labels OpenCode 2 as Preview outside the icon", () => {
    expect(DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode2")]?.badgeLabel).toBe(
      "Preview",
    );
  });
});

describe("provider model picker accessibility", () => {
  it("preserves a caller-specific trigger label", () => {
    expect(
      resolveProviderModelPickerAriaLabel("Source control writer model", "OpenCode 2, Big Pickle"),
    ).toBe("Source control writer model");
  });

  it("uses the generated provider and model label by default", () => {
    expect(resolveProviderModelPickerAriaLabel(undefined, "OpenCode 2, Big Pickle")).toBe(
      "OpenCode 2, Big Pickle",
    );
  });
});
