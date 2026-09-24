import * as NodeAssert from "node:assert/strict";

import * as RegExpUtils from "effect/RegExp";
import { describe, it } from "vite-plus/test";
import type { FormInfo } from "@opencode/client";

import {
  buildOpenCodePermissionRules,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
} from "./opencodeRuntime.ts";

function actionFor(
  runtimeMode: Parameters<typeof buildOpenCodePermissionRules>[0],
  permission: string,
  target = "*",
) {
  // OpenCode uses the last matching rule. Its wildcards match directory separators.
  return buildOpenCodePermissionRules(runtimeMode).findLast(
    (rule) =>
      (rule.action === "*" || rule.action === permission) &&
      new RegExp(`^${RegExpUtils.escape(rule.resource).replaceAll("\\*", ".*")}$`, "s").test(
        target,
      ),
  )?.effect;
}

describe("buildOpenCodePermissionRules", () => {
  it("pre-approves edits once the user has chosen to auto-accept them", () => {
    NodeAssert.equal(actionFor("auto-accept-edits", "edit"), "allow");
  });

  it("still asks before editing when approval is required", () => {
    NodeAssert.equal(actionFor("approval-required", "edit"), "ask");
  });

  // Documented in docs/user/permission-modes.md: providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for "auto".
  it("leaves auto asking, as the docs say it does without a reviewer", () => {
    NodeAssert.equal(actionFor("auto", "edit"), "ask");
  });

  it("allows workspace reads and task updates without asking in supervised modes", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const permission of ["read", "glob", "grep", "lsp", "skill", "todowrite"]) {
        NodeAssert.equal(actionFor(runtimeMode, permission, "src/index.ts"), "allow");
      }
    }
  });

  it("preserves OpenCode's environment-file approval rules", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const target of [
        ".env",
        ".env.local",
        "config/service.env",
        "config/service.env.local",
      ]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "ask");
      }
      for (const target of [".env.example", "config/service.env.example"]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "allow");
      }
    }
  });

  it("still asks before commands, network access, external directories and unknown tools", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      NodeAssert.equal(actionFor(runtimeMode, "shell"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "webfetch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "websearch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "external_directory"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "doom_loop"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "custom_tool"), "ask");
    }
  });

  it("allows everything only under full access", () => {
    NodeAssert.deepEqual(buildOpenCodePermissionRules("full-access"), [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ]);
  });
});

describe("toOpenCodePermissionReply", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["acceptAlways", "always"],
    ["decline", "reject"],
    ["cancel", "reject"],
  ] as const)("maps %s to %s", (decision, reply) => {
    NodeAssert.equal(toOpenCodePermissionReply(decision), reply);
  });
});

describe("toOpenCodeQuestionAnswers", () => {
  it("preserves native field order and scalar values while omitting unanswered optional fields", () => {
    const request = {
      id: "form_123",
      sessionID: "session_123",
      title: "Configure run",
      fields: [
        {
          key: "model",
          type: "string",
          options: [{ label: "Balanced", value: "balanced" }],
        },
        { key: "confirmed", type: "boolean" },
        { key: "temperature", type: "number" },
        { key: "attempts", type: "integer" },
        {
          key: "tags",
          type: "multiselect",
          options: [{ label: "Review", value: "review" }],
        },
        { key: "optionalNote", type: "string", required: false },
        { key: "external", type: "external", url: "https://example.test/form" },
      ],
    } as unknown as FormInfo;

    const answers = toOpenCodeQuestionAnswers(request, {
      ignored: "ignored",
      tags: ["Review", "custom"],
      attempts: "3",
      temperature: "0.7",
      confirmed: "false",
      model: "Balanced",
    });

    NodeAssert.deepEqual(answers, {
      model: "balanced",
      confirmed: false,
      temperature: 0.7,
      attempts: 3,
      tags: ["review", "custom"],
    });
    NodeAssert.deepEqual(
      toOpenCodeQuestionAnswers(request, {
        temperature: "",
        attempts: "1.5",
      }),
      {},
    );
    NodeAssert.deepEqual(Object.keys(answers), [
      "model",
      "confirmed",
      "temperature",
      "attempts",
      "tags",
    ]);
  });

  it("prefers native option values over labels across the whole option list", () => {
    const request = {
      id: "form_values",
      sessionID: "session_123",
      title: "Confirm",
      fields: [
        {
          key: "choice",
          type: "string",
          options: [
            { label: "yes", value: "affirmative" },
            { label: "Confirm", value: "yes" },
          ],
        },
      ],
    } as unknown as FormInfo;

    // "yes" is both the first option's label and the second option's native
    // value; resolving by value first keeps the user's actual selection.
    NodeAssert.deepEqual(toOpenCodeQuestionAnswers(request, { choice: "yes" }), {
      choice: "yes",
    });
    NodeAssert.deepEqual(toOpenCodeQuestionAnswers(request, { choice: "affirmative" }), {
      choice: "affirmative",
    });
  });
});
