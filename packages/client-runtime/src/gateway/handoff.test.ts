import { describe, expect, it, vi } from "vite-plus/test";
import { performAgentHandoff, type AgentHandoffInput } from "./handoff.ts";
import type { GatewayRuntimePort } from "./port.ts";
const input: AgentHandoffInput = {
  sourceEnvironmentId: "source",
  sourceThreadId: "plan",
  environmentId: "target",
  projectId: "project",
  profileId: "code",
  handoffId: "018e1000-0000-4000-8000-000000000001",
  title: "Implement plan",
  summary: "Use a shared parser.",
  prompt: "Implement and test this plan.",
  files: ["plan.md"],
};
function fixture() {
  const port = {
    listProfiles: vi.fn(async () => [{ profileId: "code", name: "Code", revision: 3 }]),
    resolveProfileModelSelection: vi.fn(async () => ({ instanceId: "codex", model: "gpt" })),
    getThread: vi.fn(async () => ({ title: "Planning" })),
    createThread: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => ({})),
    settleThread: vi.fn(),
  } as unknown as GatewayRuntimePort;
  const files = {
    readSource: vi.fn(async () => ({ contents: "# Plan\nUse parser.ts", truncated: false })),
    writeBrief: vi.fn(async () => {}),
  };
  return { port, files };
}
describe("agent handoff", () => {
  it("copies a portable brief across environments, stamps the destination profile, and never settles the source", async () => {
    const { port, files } = fixture();
    const result = await performAgentHandoff(port, input, files);
    expect(result.status).toBe("sent");
    expect(result.sourceSettlement).toBe("confirmation-required");
    expect(port.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "target",
        profileSelection: { profileId: "code", revision: 3, overrideFields: [] },
      }),
    );
    expect(files.writeBrief).toHaveBeenCalledWith(
      result.briefPath,
      expect.stringContaining("# Plan\nUse parser.ts"),
    );
    expect(port.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(result.briefPath) }),
    );
    expect(port.settleThread).not.toHaveBeenCalled();
  });
  it("does not create a chat if a selected file is missing or truncated", async () => {
    const { port, files } = fixture();
    files.readSource.mockResolvedValue({ contents: "cut", truncated: true });
    await expect(performAgentHandoff(port, input, files)).rejects.toThrow("too large");
    expect(port.createThread).not.toHaveBeenCalled();
  });
  it("reports the created chat on delivery failure without settling or creating a replacement", async () => {
    const { port, files } = fixture();
    files.writeBrief.mockRejectedValue(new Error("disk full"));
    const result = await performAgentHandoff(port, input, files);
    expect(result).toMatchObject({ status: "created", error: "disk full" });
    expect(port.createThread).toHaveBeenCalledTimes(1);
    expect(port.sendMessage).not.toHaveBeenCalled();
    expect(port.settleThread).not.toHaveBeenCalled();
  });
  it("rejects paths outside the source workspace before reading them", async () => {
    const { port, files } = fixture();
    await expect(
      performAgentHandoff(port, { ...input, files: ["../secrets"] }, files),
    ).rejects.toThrow("relative");
    expect(files.readSource).not.toHaveBeenCalled();
  });
});

it.each(["failed", "denied"] as const)(
  "stops after %s creation without writing or sending",
  async (status) => {
    const { port, files } = fixture();
    vi.mocked(port.createThread).mockResolvedValue({ status } as Awaited<
      ReturnType<typeof port.createThread>
    >);
    await expect(performAgentHandoff(port, input, files)).rejects.toThrow(`creation ${status}`);
    expect(files.writeBrief).not.toHaveBeenCalled();
    expect(port.sendMessage).not.toHaveBeenCalled();
  },
);
it("does not report a rejected send as delivered", async () => {
  const { port, files } = fixture();
  vi.mocked(port.sendMessage).mockResolvedValue({ status: "denied" } as Awaited<
    ReturnType<typeof port.sendMessage>
  >);
  expect(await performAgentHandoff(port, input, files)).toMatchObject({
    status: "created",
    error: expect.stringContaining("denied"),
  });
});
