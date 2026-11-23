import { expect, it } from "vite-plus/test";
import { extensionPanelDocument } from "./extensionPanel.ts";

it.each([
  ["<!doctype html><!-- <head> --><html><head>", "<script>window.t3Extension.context;</script>"],
  [
    '<!-- before doctype --><!doctype html><html lang="en"><head data-label="a > b">',
    "<script>window.t3Extension.context;</script>",
  ],
  ["<!-- <html> --><!doctype html>", "<script>window.t3Extension.context;</script>"],
  ["", "<script>window.t3Extension.context;</script>"],
])("installs the bridge at the start of the panel document after %j", (prefix, content) => {
  const document = extensionPanelDocument(
    prefix + content,
    { surface: "web" },
    "channel",
    { appearance: "light", variables: {} },
    {},
  );

  expect(document.startsWith(prefix + "<script>")).toBe(true);
  expect(document.indexOf("window.t3Extension={")).toBeLessThan(document.indexOf(content));
  expect(document.endsWith(content)).toBe(true);
});
