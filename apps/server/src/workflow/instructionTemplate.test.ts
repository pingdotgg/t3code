import { assert, describe, it } from "@effect/vitest";

import {
  applyInstructionTemplate,
  applyInstructionTemplateExcept,
  descriptionSpillPath,
  descriptionSpillReference,
  findHandoffReferences,
  handoffSpillPath,
  handoffSpillReference,
  instructionBodyBudget,
  NO_PRIOR_OUTPUT_NOTE,
  providerInputBudget,
  renderTicketDiscussion,
  safeStepKey,
  stringifyHandoffOutput,
  ticketScratchDir,
  unknownTicketPlaceholders,
  type DiscussionMessage,
} from "./instructionTemplate.ts";

const vars = {
  title: "Fix login bug",
  description: "Users get logged out",
  id: "ticket-42",
  baseRef: "refs/t3/tickets/abc/base",
  discussion: "(no discussion yet)",
};

describe("applyInstructionTemplate", () => {
  it("substitutes known ticket placeholders", () => {
    const result = applyInstructionTemplate(
      "Review {{ticket.title}} ({{ticket.id}}): diff against {{ ticket.baseRef }}.",
      vars,
    );
    assert.equal(
      result,
      "Review Fix login bug (ticket-42): diff against refs/t3/tickets/abc/base.",
    );
  });

  it("substitutes description and tolerates repeated placeholders", () => {
    const result = applyInstructionTemplate(
      "{{ticket.description}} / {{ticket.description}}",
      vars,
    );
    assert.equal(result, "Users get logged out / Users get logged out");
  });

  it("leaves unknown ticket placeholders literal", () => {
    const result = applyInstructionTemplate("Check {{ticket.priority}}", vars);
    assert.equal(result, "Check {{ticket.priority}}");
  });

  it("ignores non-ticket handlebars text", () => {
    const result = applyInstructionTemplate("Use {{value}} and {{ other.thing }}", vars);
    assert.equal(result, "Use {{value}} and {{ other.thing }}");
  });
});

describe("applyInstructionTemplate discussion", () => {
  it("substitutes the discussion placeholder", () => {
    const result = applyInstructionTemplate("Context:\n{{ticket.discussion}}", vars);
    assert.equal(result, "Context:\n(no discussion yet)");
  });
});

const message = (overrides: Partial<DiscussionMessage>): DiscussionMessage => ({
  author: "user",
  body: "Looks good",
  createdAt: "2026-06-09T10:00:00.000Z",
  attachmentCount: 0,
  ...overrides,
});

describe("renderTicketDiscussion", () => {
  it("renders an empty string for no messages", () => {
    assert.equal(renderTicketDiscussion([]), "");
  });

  it("renders authors, timestamps, and bodies in order", () => {
    const rendered = renderTicketDiscussion([
      message({
        author: "user",
        body: "Use the retry helper",
        createdAt: "2026-06-09T10:00:00.000Z",
      }),
      message({ author: "agent", body: "Will do", createdAt: "2026-06-09T10:05:00.000Z" }),
    ]);
    assert.equal(
      rendered,
      [
        "### User — 2026-06-09T10:00:00.000Z",
        "Use the retry helper",
        "",
        "### Agent — 2026-06-09T10:05:00.000Z",
        "Will do",
      ].join("\n"),
    );
  });

  it("notes attachments without inlining them", () => {
    const rendered = renderTicketDiscussion([
      message({ body: "See screenshot", attachmentCount: 2 }),
    ]);
    assert.include(rendered, "See screenshot");
    assert.include(rendered, "[2 attachments omitted]");
  });

  it("notes a single attachment with singular wording", () => {
    const rendered = renderTicketDiscussion([message({ attachmentCount: 1 })]);
    assert.include(rendered, "[1 attachment omitted]");
  });

  it("keeps only the newest messages past the message cap and flags truncation", () => {
    const messages = Array.from({ length: 35 }, (_, index) =>
      message({
        body: `note ${index}`,
        createdAt: `2026-06-09T10:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const rendered = renderTicketDiscussion(messages);
    assert.include(rendered, "_(earlier messages omitted)_");
    assert.notInclude(rendered, "note 4\n");
    assert.include(rendered, "note 34");
    assert.include(rendered, "note 5");
  });

  it("keeps only the newest messages within the character budget", () => {
    const big = "x".repeat(5000);
    const messages = Array.from({ length: 6 }, (_, index) =>
      message({ body: `${big} tail-${index}`, createdAt: `2026-06-09T10:0${index}:00.000Z` }),
    );
    const rendered = renderTicketDiscussion(messages);
    assert.isAtMost(rendered.length, 13_000);
    assert.include(rendered, "_(earlier messages omitted)_");
    assert.include(rendered, "tail-5");
    assert.notInclude(rendered, "tail-0");
  });
});

describe("findHandoffReferences", () => {
  it("finds prev.output references", () => {
    const refs = findHandoffReferences("Use {{prev.output}} then {{ prev.output }}.");
    assert.deepEqual(
      refs.map((ref) => ({ kind: ref.kind, stepKey: ref.stepKey, raw: ref.raw })),
      [
        { kind: "prev", stepKey: undefined, raw: "{{prev.output}}" },
        { kind: "prev", stepKey: undefined, raw: "{{ prev.output }}" },
      ],
    );
  });

  it("finds step.<key>.output references and captures the key", () => {
    const refs = findHandoffReferences("Read {{step.review.output}} and {{ step.spec-1.output }}.");
    assert.deepEqual(
      refs.map((ref) => ({ kind: ref.kind, stepKey: ref.stepKey })),
      [
        { kind: "step", stepKey: "review" },
        { kind: "step", stepKey: "spec-1" },
      ],
    );
  });

  it("ignores ticket placeholders and unrelated braces", () => {
    assert.deepEqual(findHandoffReferences("{{ticket.title}} {{other}} {{step.output}}"), []);
  });
});

describe("safeStepKey", () => {
  it("passes path-safe keys through unchanged", () => {
    assert.equal(safeStepKey("review"), "review");
    assert.equal(safeStepKey("implement_2-b"), "implement_2-b");
  });

  it("encodes non-path-safe keys deterministically and path-safely", () => {
    const encoded = safeStepKey("re view/../etc");
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(encoded, safeStepKey("re view/../etc"));
    assert.notEqual(encoded, safeStepKey("review"));
  });
});

describe("stringifyHandoffOutput", () => {
  it("passes strings through unchanged", () => {
    assert.equal(stringifyHandoffOutput("hello"), "hello");
  });

  it("JSON-stringifies non-string output", () => {
    assert.equal(stringifyHandoffOutput({ verdict: "approve" }), '{"verdict":"approve"}');
    assert.equal(stringifyHandoffOutput(null), "null");
  });
});

describe("handoffSpillPath / handoffSpillReference", () => {
  it("builds a per-ticket handoff scratch path under .t3/ticket", () => {
    assert.equal(handoffSpillPath("ticket-42", "review"), ".t3/ticket/ticket-42/handoff/review.md");
  });

  it("renders a path reference message pointing at the spilled file", () => {
    const reference = handoffSpillReference(".t3/ticket/ticket-42/handoff/review.md");
    assert.include(reference, ".t3/ticket/ticket-42/handoff/review.md");
    assert.include(reference, "read");
  });
});

describe("providerInputBudget", () => {
  it("falls back to the 120k cap when undefined", () => {
    assert.equal(providerInputBudget(undefined), 120000);
  });

  it("uses a tighter provider limit when smaller than the cap", () => {
    assert.equal(providerInputBudget(3000), 3000);
  });

  it("clamps an over-cap provider limit to the 120k cap", () => {
    assert.equal(providerInputBudget(999999), 120000);
  });
});

describe("instructionBodyBudget", () => {
  it("subtracts the discussion block and capture reserve for capture steps", () => {
    assert.equal(instructionBodyBudget(3000, 500, true), 1988);
  });

  it("floors at 0 when the appended block exceeds the budget", () => {
    assert.equal(instructionBodyBudget(3000, 12000, true), 0);
  });

  it("omits the capture reserve for non-capture steps", () => {
    assert.equal(instructionBodyBudget(3000, 500, false), 2500);
  });
});

describe("applyInstructionTemplateExcept", () => {
  it("substitutes included fields and leaves excluded placeholders literal", () => {
    assert.equal(
      applyInstructionTemplateExcept("{{ticket.title}}|{{ ticket.description }}", { title: "T" }, [
        "description",
      ]),
      "T|{{ ticket.description }}",
    );
  });
});

describe("ticketScratchDir / descriptionSpillPath", () => {
  it("builds a per-ticket scratch dir under .t3/ticket", () => {
    assert.equal(ticketScratchDir("ticket-1"), ".t3/ticket/ticket-1");
  });

  it("rejects a non-path-safe ticket id", () => {
    assert.throws(() => ticketScratchDir("../evil"));
  });

  it("builds the DESCRIPTION.md spill path under the scratch dir", () => {
    assert.equal(descriptionSpillPath("ticket-1"), ".t3/ticket/ticket-1/DESCRIPTION.md");
  });

  it("renders a path reference pointing at the spilled description", () => {
    const reference = descriptionSpillReference(".t3/ticket/ticket-1/DESCRIPTION.md");
    assert.include(reference, ".t3/ticket/ticket-1/DESCRIPTION.md");
    assert.include(reference, "read");
  });
});

describe("NO_PRIOR_OUTPUT_NOTE", () => {
  it("is the explicit forward-reference marker", () => {
    assert.equal(NO_PRIOR_OUTPUT_NOTE, "(no prior output yet)");
  });
});

describe("unknownTicketPlaceholders", () => {
  it("reports unknown ticket fields once each", () => {
    const unknown = unknownTicketPlaceholders(
      "{{ticket.title}} {{ticket.priority}} {{ticket.priority}} {{ticket.owner.name}}",
    );
    assert.deepEqual([...unknown].sort(), ["owner.name", "priority"]);
  });

  it("reports nothing for known fields or non-ticket braces", () => {
    assert.deepEqual(
      unknownTicketPlaceholders("{{ticket.title}} {{ticket.baseRef}} {{whatever}}"),
      [],
    );
  });
});
