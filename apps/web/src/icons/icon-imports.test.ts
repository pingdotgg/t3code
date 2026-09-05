import { describe, expect, it } from "vite-plus/test";

import { assertKnownIconNames, collectRuntimeIconNames } from "./icon-import-parser";

describe("collectRuntimeIconNames", () => {
  it("collects runtime imports and ignores declaration and inline types", () => {
    const source = `
      import type { LucideIcon } from "~/icons";
      import { CheckIcon, type LucideProps, X as CloseIcon } from "~/icons";
      import { LucideIcon as IconType, LucideProps } from "~/icons";
      import { CircleAlertIcon } from "lucide-react";
    `;

    expect(collectRuntimeIconNames(source)).toEqual(["CheckIcon", "X", "CircleAlertIcon"]);
  });

  it("ignores import-shaped text outside import declarations", () => {
    const source = `
      // import { CommentIcon } from "~/icons";
      const string = 'import { StringIcon } from "~/icons"';
      const template = \`import { TemplateIcon } from "~/icons"\`;
      const regex = /import { RegexIcon } from "lucide-react"/;
      const jsx = <p>import {JsxTextIcon} from "lucide-react"</p>;
      import { CheckIcon } from "~/icons";
    `;

    expect(collectRuntimeIconNames(source)).toEqual(["CheckIcon"]);
  });

  it("keeps imports after JSX attribute expressions", () => {
    const source = `
      const button = <button onClick={() => count > 0} data-count={count++ / divisor} />;
      import { CheckIcon } from "~/icons";
    `;

    expect(collectRuntimeIconNames(source)).toEqual(["CheckIcon"]);
  });

  it("handles aliases and comments inside named imports", () => {
    const source = `
      import {
        /* primary */ SendIcon as Send,
        // secondary
        XIcon,
      } from "~/icons";
    `;

    expect(collectRuntimeIconNames(source)).toEqual(["SendIcon", "XIcon"]);
  });

  it("rejects a runtime icon that Lucide does not export", () => {
    expect(() =>
      assertKnownIconNames(["MissingIcon"], new Set(["CheckIcon"]), "fixture.tsx"),
    ).toThrow("fixture.tsx imports MissingIcon, which lucide-react does not export.");
  });
});
