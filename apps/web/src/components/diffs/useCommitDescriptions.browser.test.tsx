import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ allowed: true, generate: vi.fn() }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.allowed }));
vi.mock("~/state/review", () => ({
  reviewEnvironment: { commitDescriptions: { permissionAtom: () => null } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.generate }));

import { useCommitDescriptions } from "./useCommitDescriptions";

const shas = Array.from({ length: 25 }, (_, index) => `sha${index}`);
const defaults = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  cwd: "/repo",
  modelKey: "model-a",
  shas,
  enabled: true,
  visible: true,
  open: false,
};

function Probe(props: Partial<typeof defaults>) {
  const [open, setOpen] = useState(false);
  const { descriptions, retry } = useCommitDescriptions({ ...defaults, open, ...props });
  return (
    <>
      <button
        onClick={() => {
          if (!open) retry();
          setOpen(!open);
        }}
      >
        {open ? "Close menu" : "Open menu"}
      </button>
      <output aria-label="Summary count">{descriptions.size}</output>
      <ul aria-label="Summaries">
        {[...descriptions].map(([sha, description]) => (
          <li key={sha}>{description}</li>
        ))}
      </ul>
    </>
  );
}

function setup() {
  mocks.allowed = true;
  mocks.generate.mockReset();
  type Result = AtomCommandResult<
    { descriptions: Array<{ sha: string; description: string }> },
    Error
  >;
  const requests: Array<{ shas: string[]; resolve: (result: Result) => void }> = [];
  mocks.generate.mockImplementation(
    ({ input }: { input: { shas: string[] } }) =>
      new Promise<Result>((resolve) => {
        requests.push({ shas: input.shas, resolve });
      }),
  );
  return {
    async fail(index: number) {
      await act(() =>
        requests[index]!.resolve(AsyncResult.failure(Cause.fail(new Error("Failed")))),
      );
    },
    async complete(index: number, description = "Prepared summary") {
      const request = requests[index]!;
      await act(() =>
        request.resolve(
          AsyncResult.success({ descriptions: request.shas.map((sha) => ({ sha, description })) }),
        ),
      );
    },
  };
}

it("prepares the first ten summaries before the menu opens and reuses them on reopening", async () => {
  const test = setup();
  await using screen = await render(<Probe />);
  expect(mocks.generate).toHaveBeenCalledExactlyOnceWith({
    environmentId: defaults.environmentId,
    input: { cwd: "/repo", threadId: defaults.threadId, shas: shas.slice(0, 10) },
  });
  await test.complete(0);
  await screen.rerender(<Probe open />);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  await screen.rerender(<Probe open={false} />);
  await screen.rerender(<Probe open />);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("starts no generation while hidden and retains loaded summaries across hiding", async () => {
  const test = setup();
  await using screen = await render(<Probe visible={false} />);
  expect(mocks.generate).not.toHaveBeenCalled();
  await screen.rerender(<Probe />);
  await test.complete(0);
  await screen.rerender(<Probe visible={false} shas={[]} />);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  await screen.rerender(<Probe open />);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it("retries a failed batch only on menu reopening and preserves successful summaries", async () => {
  const test = setup();
  await using screen = await render(<Probe />);
  await test.complete(0);
  const changed = ["new-sha", "other-new-sha", ...shas];
  await screen.rerender(<Probe shas={changed} />);
  await screen.getByRole("button", { name: "Open menu" }).click();
  await test.fail(1);
  await screen.rerender(<Probe shas={changed} />);
  await screen.rerender(<Probe visible={false} shas={changed} />);
  await screen.rerender(<Probe shas={changed} />);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  await screen.getByRole("button", { name: "Close menu" }).click();
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  await screen.getByRole("button", { name: "Open menu" }).click();
  expect(mocks.generate).toHaveBeenCalledTimes(3);
  expect(mocks.generate.mock.calls[2]![0].input.shas).toEqual(["new-sha", "other-new-sha"]);
  await screen.getByRole("button", { name: "Close menu" }).click();
  await screen.getByRole("button", { name: "Open menu" }).click();
  expect(mocks.generate).toHaveBeenCalledTimes(3);
  await test.complete(2, "Retried summary");
  await expect.element(screen.getByText("Retried summary").first()).toBeVisible();
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("12");
  await expect.element(screen.getByRole("listitem").first()).toHaveTextContent("Prepared summary");
  expect(mocks.generate).toHaveBeenCalledTimes(3);
});

it("serializes changed commit lists and waits until the panel is visible to fetch missing summaries", async () => {
  const test = setup();
  await using screen = await render(<Probe open />);
  const changed = ["new-sha", ...shas];
  await screen.rerender(<Probe open shas={changed} />);
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  await screen.rerender(<Probe visible={false} shas={changed} />);
  await test.complete(0);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  await screen.rerender(<Probe open shas={changed} />);
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1]![0].input.shas).toEqual(["new-sha"]);
  await test.complete(1, "New commit summary");
  await expect.element(screen.getByText("New commit summary")).toBeVisible();
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("11");
});

it.each([
  { modelKey: "model-b" },
  {
    modelKey: JSON.stringify({
      instanceId: "codex",
      model: "model-a",
      options: { effort: "max" },
    }),
  },
  { environmentId: EnvironmentId.make("other-environment") },
  { threadId: ThreadId.make("other-thread") },
  { cwd: "/other-repo" },
])("drops old summaries when the scope changes: %j", async (change) => {
  const test = setup();
  await using screen = await render(<Probe />);
  await screen.rerender(<Probe {...change} />);
  await test.complete(0, "Old summary");
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("0");
  await test.complete(1, "New summary");
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  await expect.element(screen.getByRole("listitem").first()).toHaveTextContent("New summary");
  expect(mocks.generate).toHaveBeenCalledTimes(2);
});

it("rejects late results after switching away and back to the same model", async () => {
  const test = setup();
  await using screen = await render(<Probe />);
  await screen.rerender(<Probe modelKey="model-b" />);
  await screen.rerender(<Probe />);
  await test.complete(0, "Old summary");
  await test.complete(1, "Other model summary");
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("0");
  await test.complete(2, "Current summary");
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  await expect.element(screen.getByRole("listitem").first()).toHaveTextContent("Current summary");
});

it("waits for readiness and drops cached and late summaries when the grant is revoked", async () => {
  const test = setup();
  await using screen = await render(<Probe enabled={false} />);
  expect(mocks.generate).not.toHaveBeenCalled();
  await screen.rerender(<Probe />);
  await test.complete(0);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  mocks.allowed = false;
  await screen.rerender(<Probe />);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("0");
  mocks.allowed = true;
  await screen.rerender(<Probe />);
  mocks.allowed = false;
  await screen.rerender(<Probe />);
  await test.complete(1, "Revoked summary");
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("0");
  mocks.allowed = true;
  await screen.rerender(<Probe />);
  await test.complete(2);
  await expect.element(screen.getByLabelText("Summary count")).toHaveTextContent("10");
  expect(mocks.generate).toHaveBeenCalledTimes(3);
});
