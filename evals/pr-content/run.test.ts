import { expect, it } from "vite-plus/test";
import { gradePrContent } from "./grade.ts";

it.each([
  {
    title: "Retire legacy model",
    body: "## Summary\n- Add retirement metadata.\n## Testing\n- Not run",
    passed: true,
  },
  {
    title: "Blocked: cannot access PR status",
    body: "Cannot start babysitting without GitHub access.",
    passed: false,
  },
  {
    title: "Retire legacy model",
    body: "Please provide the PR number so I can start babysitting.",
    passed: false,
  },
  { title: "Watch CI", body: "All checks passed.", passed: false },
  { title: "Retire legacy model", body: "All checks passed.", passed: false },
  {
    title: "Retire legacy model",
    body: "## Summary\n- Add a retirement date and successor.\n## Testing\n- All checks passed.",
    passed: true,
  },
])("grades $title", ({ title, body, passed }) => {
  expect(gradePrContent({ title, body })).toBe(passed);
});
