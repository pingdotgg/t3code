import { describe, expect, it } from "vite-plus/test";

import { createAnnotationIdSource } from "./AnnotationIds.ts";

describe("createAnnotationIdSource", () => {
  it("gives annotations picked on separate page loads distinct ids", () => {
    const firstLoad = createAnnotationIdSource();
    firstLoad("element");
    const firstAnnotation = firstLoad("annotation");

    const secondLoad = createAnnotationIdSource();
    secondLoad("element");
    const secondAnnotation = secondLoad("annotation");

    expect(secondAnnotation).not.toBe(firstAnnotation);
  });
});
