import { describe, expect, it } from "vite-plus/test";

import { parseAcceptanceCriteria } from "./acceptanceCriteria.logic";

describe("parseAcceptanceCriteria", () => {
  it("returns null when body is empty or has no matching heading", () => {
    expect(parseAcceptanceCriteria(null)).toBeNull();
    expect(parseAcceptanceCriteria("")).toBeNull();
    expect(parseAcceptanceCriteria("## Summary\n\n- [ ] not under the right heading")).toBeNull();
  });

  it("reads checked and unchecked tasks under Acceptance criteria", () => {
    const body = `## Summary

Something.

## Acceptance criteria

- [ ] First item
- [x] Second item
* [X] Third item

## Notes

- [ ] Ignored after next equal heading
`;
    expect(parseAcceptanceCriteria(body)).toEqual({
      heading: "Acceptance criteria",
      items: [
        { text: "First item", checked: false },
        { text: "Second item", checked: true },
        { text: "Third item", checked: true },
      ],
    });
  });

  it("stops at a heading of equal or higher rank, keeps deeper headings", () => {
    const body = `### Acceptance Criteria

- [ ] Keep

#### Nested

- [x] Still in section

## Other

- [ ] Stopped
`;
    expect(parseAcceptanceCriteria(body)?.items).toEqual([
      { text: "Keep", checked: false },
      { text: "Still in section", checked: true },
    ]);
  });

  it("matches the heading case-insensitively", () => {
    expect(parseAcceptanceCriteria("## ACCEPTANCE CRITERIA\n\n- [ ] One")?.heading).toBe(
      "ACCEPTANCE CRITERIA",
    );
  });
});
