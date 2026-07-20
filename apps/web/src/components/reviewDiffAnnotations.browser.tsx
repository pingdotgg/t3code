import "../index.css";

import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { ReviewFinding } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { reviewFindingAnnotation, reviewFindingSelectedLines } from "./reviewDiffAnnotations";

const patch = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-oldValue();
+newValue();
`;

const finding: ReviewFinding = {
  id: "finding-1",
  priority: "high",
  title: "Validate the new value",
  body: "The replacement needs validation.",
  confidence: 0.95,
  location: {
    path: "src/example.ts",
    side: "new",
    startLine: 1,
    endLine: 1,
  },
};

const fileDiff = parsePatchFiles(patch)[0]?.files[0];

function RepeatedRenderHarness() {
  const [renderCount, setRenderCount] = useState(0);
  const annotations = useMemo(() => [reviewFindingAnnotation(finding)], []);
  const selectedLines = useMemo(() => reviewFindingSelectedLines(finding), []);

  useEffect(() => {
    if (renderCount < 20) {
      setRenderCount((current) => current + 1);
    }
  }, [renderCount]);

  if (!fileDiff) {
    return null;
  }

  return (
    <div>
      <output aria-label="render count">{renderCount}</output>
      <Virtualizer>
        <FileDiff<ReviewFinding>
          fileDiff={fileDiff}
          lineAnnotations={annotations}
          selectedLines={selectedLines}
          renderAnnotation={(annotation) => <p>{annotation.metadata.body}</p>}
        />
      </Virtualizer>
    </div>
  );
}

describe("review diff annotations", () => {
  it("remain stable across repeated parent renders", async () => {
    await render(<RepeatedRenderHarness />);

    await expect.element(page.getByLabelText("render count")).toHaveTextContent("20");
    await expect.element(page.getByText("The replacement needs validation.")).toBeVisible();
  });
});
