import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

import { MarkdownLinkContext } from "./ChatMarkdownMedia";
import { MarkdownExternalLinkContent } from "./MarkdownExternalLink";

it.each(["plain", "formatted"] as const)(
  "keeps %s long links bounded in the DOM without losing text or wrapping",
  async (kind) => {
    const link = (url: string) => (
      <div className="chat-markdown w-64">
        <table>
          <tbody>
            <tr>
              <td>
                <a href={url}>
                  <MarkdownExternalLinkContent
                    host="github.com"
                    plainText={kind === "plain" ? url : null}
                  >
                    <MarkdownLinkContext value>
                      {url}
                      {kind === "formatted" ? <strong> details</strong> : null}
                    </MarkdownLinkContext>
                  </MarkdownExternalLinkContent>
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
    const url = (length: number) => `https://github.com/search?q=${"a".repeat(length)}`;
    await using screen = await render(link(url(128)));
    const initialElementCount = screen.container.querySelectorAll("a *").length;

    const longUrl = url(16_000);
    await screen.rerender(link(longUrl));
    await vi.waitFor(() => {
      const anchor = screen.container.querySelector("a")!;
      const table = screen.container.querySelector("table")!;
      expect(anchor.getAttribute("href")).toBe(longUrl);
      expect(anchor.textContent).toBe(longUrl + (kind === "formatted" ? " details" : ""));
      expect(anchor.querySelectorAll("*")).toHaveLength(initialElementCount);
      if (kind === "formatted")
        expect(anchor.querySelector("strong")?.textContent).toBe(" details");
      expect(table.scrollWidth).toBeLessThanOrEqual(
        screen.container.firstElementChild!.clientWidth,
      );
    });
  },
);
