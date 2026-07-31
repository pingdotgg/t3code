import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Command, CommandFooter, CommandInput } from "./command";

describe("command compact geometry", () => {
  it("keeps shell selectors on the wrapper and direct-input padding on AutocompleteInput", () => {
    const html = renderToStaticMarkup(
      <Command>
        <CommandInput placeholder="Search commands" />
      </Command>,
    );
    const shellClass = html.match(/class="([^"]*px-\[var\(--command-shell-inset\)[^"]*)"/)?.[1];
    const inputClass = html.match(/class="([^"]*has-focus-visible:ring-0[^"]*)"/)?.[1];

    expect(shellClass).toContain(
      "[&amp;_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-shell-inset)+0.0625rem)]",
    );
    expect(shellClass).not.toContain("sm:*:data-[slot=autocomplete-input]");
    expect(inputClass).toContain(
      "sm:*:data-[slot=autocomplete-input]:ps-[calc(var(--command-shell-inset)+1.5rem)]!",
    );
  });

  it("uses the semantic footer inset without changing compact vertical padding", () => {
    const html = renderToStaticMarkup(<CommandFooter>Shortcuts</CommandFooter>);

    expect(html).toContain("px-[var(--command-content-inset)]");
    expect(html).toContain("py-2.5");
  });
});
