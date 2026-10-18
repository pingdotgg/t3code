import { describe, expect, it } from "vite-plus/test";

import { createAnnotationIdSource } from "./AnnotationIds.ts";

describe("createAnnotationIdSource", () => {
  it("gives annotations picked on separate page loads distinct ids", () => {
    // The picker preload runs afresh on every page load, while the composer
    // keeps earlier annotations keyed by id.
    const firstLoad = createAnnotationIdSource();
    firstLoad("element");
    const firstAnnotation = firstLoad("annotation");

    const secondLoad = createAnnotationIdSource();
    secondLoad("element");
    const secondAnnotation = secondLoad("annotation");

    expect(secondAnnotation).not.toBe(firstAnnotation);
  });

  it("never repeats an id within one page load", () => {
    const nextId = createAnnotationIdSource();
    const ids = Array.from({ length: 1_000 }, () => nextId("annotation"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
