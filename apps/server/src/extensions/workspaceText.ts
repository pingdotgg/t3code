import * as NodeBuffer from "node:buffer";
import type { ProjectReadFileResult } from "@t3tools/contracts";
import { validateWorkspaceReadTextResult } from "@t3tools/extension-sdk/workspace";

/** Bound the whole serialized result, including escaped content and path metadata. */
export function boundedWorkspaceText(value: ProjectReadFileResult) {
  const budget = 64 * 1024;
  const fits = (length: number) =>
    NodeBuffer.Buffer.byteLength(
      JSON.stringify({
        ...value,
        contents: value.contents.slice(0, length),
        truncated: value.truncated || length < value.contents.length,
      }),
      "utf8",
    ) <= budget;
  let low = 0;
  let high = Math.min(value.contents.length, budget);
  if (!fits(0)) throw new Error("Workspace text metadata exceeds the result budget.");
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0 &&
    low < value.contents.length &&
    /[\uD800-\uDBFF]/.test(value.contents[low - 1]!) &&
    /[\uDC00-\uDFFF]/.test(value.contents[low]!)
  )
    low--;
  return validateWorkspaceReadTextResult({
    ...value,
    contents: value.contents.slice(0, low),
    truncated: value.truncated || low < value.contents.length,
  });
}
