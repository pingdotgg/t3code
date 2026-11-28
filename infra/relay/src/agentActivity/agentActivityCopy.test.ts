import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  agentActivityCopy,
  liveActivityCopy,
  localizeAggregateState,
  resolveAgentActivityLocale,
} from "./agentActivityCopy.ts";
import { alertForActivityRows } from "./agentActivityAlerts.ts";

const row = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "waiting_for_approval" as const,
  status: "Approval",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};

const aggregate: RelayAgentActivityAggregateState = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 2,
  updatedAt: row.updatedAt,
  activities: [row, { ...row, threadId: ThreadId.make("other"), phase: "running" }],
};

describe("agentActivityCopy", () => {
  it("resolves app locales and their regional variants", () => {
    expect(resolveAgentActivityLocale("zh")).toBe("zh");
    expect(resolveAgentActivityLocale("pt-br")).toBe("pt-BR");
    expect(resolveAgentActivityLocale("zh-Hans-CN")).toBe("zh");
    expect(resolveAgentActivityLocale("nl")).toBeNull();
    expect(resolveAgentActivityLocale(undefined)).toBeNull();
  });

  it("falls back to the relay's English for unknown locales", () => {
    const copy = agentActivityCopy("nl");
    expect(alertForActivityRows([row], copy)).toEqual({
      title: "Thread",
      body: "Approval: Project",
    });
    expect(alertForActivityRows([row, row], copy)?.title).toBe("2 agents need attention");
  });

  it("leaves English Live Activity content to the widget's built-in copy", () => {
    expect(liveActivityCopy("en")).toBeUndefined();
    expect(liveActivityCopy(null)).toBeUndefined();
    expect(liveActivityCopy("zh")).toBe(agentActivityCopy("zh"));
  });

  it("keeps dollar sequences in project titles literal", () => {
    expect(
      alertForActivityRows([{ ...row, projectTitle: "Budget $$ $&" }], agentActivityCopy("en"))
        ?.body,
    ).toBe("Approval: Budget $$ $&");
  });

  it("translates alerts with the locale's plural rules", () => {
    expect(alertForActivityRows([row], agentActivityCopy("zh"))?.body).toBe("待批准：Project");
    expect(alertForActivityRows([row, row], agentActivityCopy("ru"))?.title).toBe(
      "2 агента требуют внимания",
    );
    const finished = { ...row, phase: "completed" as const };
    expect(
      alertForActivityRows(
        Array.from({ length: 5 }, () => finished),
        agentActivityCopy("ru"),
      )?.title,
    ).toBe("5 агентов завершили работу");
  });

  it("localizes statuses and sends only the counts the aggregate can show", () => {
    const copy = agentActivityCopy("zh");
    expect(localizeAggregateState(aggregate, copy)).toMatchObject({
      subtitle: "智能体工作进行中",
      activities: [{ status: "待批准" }, { status: "运行中" }],
    });
    expect(copy.text(aggregate)).toMatchObject({
      activeAgents: { "2": "2 个活跃智能体" },
      active: { "2": "2 个活跃" },
      needAttention: { "1": "1 个需要关注", "2": "2 个需要关注" },
      needYou: {},
    });
    expect(Object.keys(copy.text(aggregate).activeAgents)).toEqual(["2"]);
  });
});
