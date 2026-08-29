import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentsPanel } from "./AgentsPanel";

function childActivity(
  status: "running" | "waiting" | "idle",
  index = 1,
  model: string | null = "z-ai/glm-5.3-flash",
): OrchestrationThreadActivity {
  return {
    id: `glm-child-${index}-${status}`,
    tone: "info",
    kind: status === "running" ? "task.started" : "task.updated",
    summary: "Native GLM child",
    payload: {
      taskId: `native-glm-child-thread-${index}`,
      agentKind: "agent",
      title: `glm_worker_${index}`,
      role: "researcher",
      modelProvider: "openrouter",
      model,
      effort: "max",
      status,
      timelineBypass: true,
    },
    turnId: null,
    createdAt: `2026-08-29T12:00:0${status === "running" ? 0 : status === "waiting" ? 1 : 2}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function panelMarkup(activities: ReadonlyArray<OrchestrationThreadActivity>): string {
  const model = deriveAgentPanelModel({ agents: foldSubagentActivities(activities) });
  return renderToStaticMarkup(<AgentsPanel model={model} />);
}

describe("AgentsPanel native GLM child", () => {
  it("renders running and waiting as Working, then renders the resumable child as idle", () => {
    const running = panelMarkup([childActivity("running")]);
    expect(running).toContain("glm_worker_1");
    expect(running).toContain("openrouter · z-ai/glm-5.3-flash · max");
    expect(running).toContain("Working");
    expect(running).toContain("1 working");

    const waiting = panelMarkup([childActivity("running"), childActivity("waiting")]);
    expect(waiting).toContain("Working");
    expect(waiting).toContain("1 working");

    const idle = panelMarkup([
      childActivity("running"),
      childActivity("waiting"),
      childActivity("idle"),
    ]);
    expect(idle).toContain("glm_worker_1");
    expect(idle).toContain("openrouter · z-ai/glm-5.3-flash · max");
    expect(idle).toContain("Idle · resumable");
    expect(idle).toContain("1 idle");
    expect(idle).not.toContain("1 working");
  });

  it("keeps a provider session with no native child events out of the roster", () => {
    const markup = panelMarkup([]);
    expect(markup).toContain("No agents yet");
    expect(markup).not.toContain("glm_worker_1");
  });

  it("does not render a provider label before the child model is known", () => {
    const markup = panelMarkup([childActivity("running", 1, null)]);
    expect(markup).toContain("glm_worker_1");
    expect(markup).not.toContain("openrouter");
    expect(markup).not.toContain(" · max");
  });

  it("renders ten simultaneous native children without collapsing the roster", () => {
    const markup = panelMarkup(
      Array.from({ length: 10 }, (_, index) => childActivity("running", index + 1)),
    );
    expect(markup).toContain("10 working");
    for (let index = 1; index <= 10; index++) {
      expect(markup).toContain(`glm_worker_${index}`);
    }
    expect(markup.match(/openrouter · z-ai\/glm-5\.3-flash · max/g)).toHaveLength(10);
  });
});
