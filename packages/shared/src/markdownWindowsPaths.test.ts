import { expect, it, vi } from "vite-plus/test";
import { unified, type PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { remarkKeepWindowsPaths, remarkKeepWindowsProsePaths } from "./markdownWindowsPaths.ts";

it.each([
  ["remarkKeepWindowsPaths", remarkKeepWindowsPaths],
  ["remarkKeepWindowsProsePaths", remarkKeepWindowsProsePaths],
] as const)("%s inspects prose escapes in linear time", (_, plugin) => {
  const markdown = `Supported metrics: ${Array.from(
    { length: 400 },
    (_, index) => String.raw`metric\_name\_${index}`,
  ).join(", ")}`;
  const regexInputLength = (plugins: PluggableList) => {
    let total = 0;
    const exec = RegExp.prototype.exec;
    using _spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      input: string,
    ) {
      total += input.length;
      return exec.call(this, input);
    });
    unified().use(remarkParse).use(plugins).parse(markdown);
    return total;
  };

  const baseline = regexInputLength([remarkGfm]);
  const withPlugin = regexInputLength([remarkGfm, plugin]);

  // Each escape should only look back over the whitespace-free run it ends.
  expect(withPlugin - baseline).toBeLessThanOrEqual(2 * markdown.length);
});
