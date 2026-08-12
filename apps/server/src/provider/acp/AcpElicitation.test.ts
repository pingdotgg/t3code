import { describe, expect, it } from "vite-plus/test";

import { buildAcpElicitationForm } from "./AcpElicitation.ts";

describe("AcpElicitation", () => {
  it("maps labeled selects and booleans back to ACP form values", () => {
    const form = buildAcpElicitationForm({
      mode: "form",
      sessionId: "session-1",
      message: "Choose how to continue",
      requestedSchema: {
        type: "object",
        required: ["strategy", "confirmed"],
        properties: {
          strategy: {
            type: "string",
            title: "Strategy",
            oneOf: [
              { const: "safe", title: "Safe route" },
              { const: "fast", title: "Fast route" },
            ],
          },
          confirmed: {
            type: "boolean",
            title: "Confirm",
            description: "Proceed with this strategy?",
          },
        },
      },
    });

    expect(form?.questions).toEqual([
      {
        id: "strategy",
        header: "Strategy",
        question: "Strategy",
        options: [
          { label: "Safe route", description: "safe" },
          { label: "Fast route", description: "fast" },
        ],
      },
      {
        id: "confirmed",
        header: "Confirm",
        question: "Proceed with this strategy?",
        options: [
          { label: "Yes", description: "true" },
          { label: "No", description: "false" },
        ],
      },
    ]);
    expect(
      form?.resolve({
        strategy: "Safe route",
        confirmed: "Yes",
      }),
    ).toEqual({
      action: {
        action: "accept",
        content: { strategy: "safe", confirmed: true },
      },
    });
  });

  it("keeps duplicate choice titles distinguishable", () => {
    const form = buildAcpElicitationForm({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a route",
      requestedSchema: {
        required: ["route"],
        properties: {
          route: {
            type: "string",
            oneOf: [
              { const: "first", title: "Same label" },
              { const: "second", title: "Same label" },
            ],
          },
        },
      },
    });

    expect(form?.questions[0]?.options).toEqual([
      { label: "Same label", description: "first" },
      { label: "Same label (2)", description: "second" },
    ]);
    expect(form?.resolve({ route: "Same label (2)" })).toEqual({
      action: { action: "accept", content: { route: "second" } },
    });
  });

  it("accepts defaults for required optionless properties", () => {
    const form = buildAcpElicitationForm({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a route",
      requestedSchema: {
        required: ["route"],
        properties: {
          route: { type: "string", default: "default-route" },
          strategy: { type: "string", enum: ["safe", "fast"] },
        },
      },
    });

    expect(form?.resolve({ strategy: "safe" })).toEqual({
      action: {
        action: "accept",
        content: { route: "default-route", strategy: "safe" },
      },
    });
  });

  it("cancels optionless forms without questions", () => {
    expect(
      buildAcpElicitationForm({
        mode: "form",
        sessionId: "session-1",
        message: "Provide context",
        requestedSchema: {
          properties: { notes: { type: "string" } },
        },
      }),
    ).toBeUndefined();
  });

  it("supports multi-select answers", () => {
    const form = buildAcpElicitationForm({
      mode: "form",
      sessionId: "session-1",
      message: "Select targets",
      requestedSchema: {
        required: ["targets"],
        properties: {
          targets: {
            type: "array",
            description: "Select targets",
            items: {
              anyOf: [
                { const: "web", title: "Web app" },
                { const: "server", title: "Server" },
              ],
            },
          },
        },
      },
    });

    expect(form?.questions[0]?.multiSelect).toBe(true);
    expect(
      form?.resolve({
        targets: ["Web app", "Server"],
      }),
    ).toEqual({
      action: {
        action: "accept",
        content: { targets: ["web", "server"] },
      },
    });
  });

  it("rejects forms containing required optionless free-form or numeric properties", () => {
    expect(
      buildAcpElicitationForm({
        mode: "form",
        sessionId: "session-1",
        message: "Name the change",
        requestedSchema: {
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      }),
    ).toBeUndefined();
    expect(
      buildAcpElicitationForm({
        mode: "form",
        sessionId: "session-1",
        message: "Choose and explain",
        requestedSchema: {
          required: ["strategy", "count"],
          properties: {
            strategy: { type: "string", enum: ["safe", "fast"] },
            count: { type: "integer" },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("omits optional optionless properties from the form", () => {
    const form = buildAcpElicitationForm({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a strategy",
      requestedSchema: {
        required: ["strategy"],
        properties: {
          strategy: { type: "string", enum: ["safe", "fast"] },
          notes: { type: "string" },
        },
      },
    });

    expect(form?.questions).toHaveLength(1);
    expect(form?.questions[0]?.id).toBe("strategy");
  });

  it("cancels a missing required choice and ignores URL mode", () => {
    const form = buildAcpElicitationForm({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a strategy",
      requestedSchema: {
        required: ["strategy"],
        properties: { strategy: { type: "string", enum: ["safe", "fast"] } },
      },
    });

    expect(form?.resolve({})).toEqual({
      action: { action: "cancel" },
    });
    expect(
      buildAcpElicitationForm({
        mode: "url",
        sessionId: "session-1",
        elicitationId: "auth-1",
        message: "Open a browser",
        url: "https://example.com",
      }),
    ).toBeUndefined();
  });
});
