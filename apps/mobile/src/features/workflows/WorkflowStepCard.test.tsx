import { expect, it } from "@effect/vitest";
import type { WorkflowBeat } from "@t3tools/client-runtime/workflows";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vite-plus/test";

import { BeatCard } from "./WorkflowStepCard";

vi.mock("react-native", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Platform: { OS: "ios" }, Pressable: Container, Text: Container, View: Container };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: () => undefined }));
vi.mock("../../components/RelativeTime", () => ({
  RelativeTime: (props: { readonly timestamp: string }) => <time>{props.timestamp}</time>,
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/peerLinks", () => ({ useLinkedEnvironments: () => new Map() }));
vi.mock("../threads/useOpenLinkedThread", () => ({ useOpenLinkedThreadRead: () => undefined }));

const asked = (result: WorkflowBeat["result"]): WorkflowBeat => ({
  kind: "ask",
  name: "wanted",
  status: "completed",
  attempts: 1,
  detail: null,
  result,
  said: null,
  ahead: undefined,
  startMs: 0,
  endMs: 1000,
  thread: null,
  childRun: null,
  parallel: false,
});

it("shows who answered a question and when", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const card = (result: WorkflowBeat["result"], sessionId: string | null = "this-phone") =>
    act(() =>
      root.render(
        <BeatCard
          beat={asked(result)}
          sessionId={sessionId}
          onOpenThread={null}
          onOpenRun={() => {}}
        />,
      ),
    );
  try {
    card({
      choice: "No",
      answeredBy: "t3 workflow signal",
      answeredAt: "2026-11-24T10:00:00.000Z",
    });
    expect(container.textContent).toContain("Answered No");
    expect(container.textContent).toContain("by t3 workflow signal, 2026-11-24T10:00:00.000Z");
    // This phone's own answer is yours; another phone the server names the same is not.
    const fromPhone = {
      choice: "No",
      answeredBy: "T3 Code Mobile",
      answeredAt: "2026-11-24T10:00:00.000Z",
    };
    card({ ...fromPhone, answeredBySession: "this-phone" });
    expect(container.textContent).toContain("by you, 2026-11-24T10:00:00.000Z");
    expect(container.textContent).not.toContain("T3 Code Mobile");
    card({ ...fromPhone, answeredBySession: "another-phone" });
    expect(container.textContent).toContain("by T3 Code Mobile, 2026-11-24T10:00:00.000Z");
    // An answer kept before answers recorded a session names who gave it, as before.
    card(fromPhone);
    expect(container.textContent).toContain("by T3 Code Mobile, 2026-11-24T10:00:00.000Z");
    // An answer kept before answers recorded this says nothing about it.
    card({ choice: "No" });
    expect(container.textContent).not.toContain("2026");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
