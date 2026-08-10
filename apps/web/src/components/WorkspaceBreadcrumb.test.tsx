import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";

describe("WorkspaceBreadcrumb", () => {
  it("composes plain text and custom children", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceBreadcrumb ariaLabel="Project breadcrumb">
        <WorkspaceBreadcrumbItem>Projects</WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <button type="button">Switch project</button>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>,
    );

    expect(markup).toContain('aria-label="Project breadcrumb"');
    expect(markup).toContain("Projects");
    expect(markup).toContain(">/</span>");
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('<button type="button">Switch project</button>');
  });

  it("can preserve a page heading for a plain-text breadcrumb", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb">
        <WorkspaceBreadcrumbItem as="h1" current>
          Usage
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>,
    );

    expect(markup).toContain('<h1 aria-current="page"');
    expect(markup).toContain(">Usage</h1>");
  });
});
