import { expect, it } from "vite-plus/test";
import { attachmentDocumentPresentation } from "./attachmentDocumentPresentation";

it.each([
  {
    kind: "markdown",
    hasTable: false,
    hasEnvironment: false,
    rendered: true,
    renderedMode: null,
    activeMode: "source",
  },
  {
    kind: "markdown",
    hasTable: false,
    hasEnvironment: true,
    rendered: true,
    renderedMode: "markdown",
    activeMode: "markdown",
  },
  {
    kind: "markdown",
    hasTable: false,
    hasEnvironment: true,
    rendered: false,
    renderedMode: "markdown",
    activeMode: "source",
  },
  {
    kind: "text",
    hasTable: false,
    hasEnvironment: true,
    rendered: true,
    renderedMode: null,
    activeMode: "source",
  },
  {
    kind: "text",
    hasTable: true,
    hasEnvironment: false,
    rendered: true,
    renderedMode: "table",
    activeMode: "table",
  },
  {
    kind: "text",
    hasTable: true,
    hasEnvironment: true,
    rendered: false,
    renderedMode: "table",
    activeMode: "source",
  },
  {
    kind: "html",
    hasTable: false,
    hasEnvironment: false,
    rendered: true,
    renderedMode: "html",
    activeMode: "html",
  },
  {
    kind: "html",
    hasTable: false,
    hasEnvironment: true,
    rendered: false,
    renderedMode: "html",
    activeMode: "source",
  },
] as const)("matches the available preview for %j", ({ renderedMode, activeMode, ...input }) => {
  expect(attachmentDocumentPresentation(input)).toEqual({ renderedMode, activeMode });
});
