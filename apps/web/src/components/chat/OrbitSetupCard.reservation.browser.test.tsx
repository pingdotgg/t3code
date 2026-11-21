import "~/index.css";
import {
  newOrbitThreadStart,
  observeOrbitCreateRows,
  type OrbitCreateRows,
  type OrbitGatewayOperation,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { expect, it } from "vite-plus/test";

import { orbitSetupView } from "~/orbit/orbitSetupView";
import { render } from "../../../test/render";
import { OrbitSetupCard } from "./OrbitSetupCard";

/**
 * Conn: the create card of a start that finalized a reserved clone. The finalize Operation's
 * steps are Orbit's (unknown to Conn); the card keeps the approved rows and no new ones.
 */
const finalize = (
  status: OrbitGatewayOperation["status"],
  steps: NonNullable<OrbitGatewayOperation["steps"]>,
): OrbitGatewayOperation => ({
  id: 900,
  kind: "instance.finalize",
  status,
  targetId: 501,
  errorCode: null,
  pollAfterSeconds: 1,
  steps,
  completionOperationId: 901,
});

function reservedStart(rows: OrbitCreateRows | null, done: boolean): OrbitThreadStart {
  return {
    ...newOrbitThreadStart({
      id: "s1",
      project: { id: 78, slug: "orbit", nodeName: "beast" },
      message: "Fix the login page",
      suffix: "x",
      threadId: "thread-1",
      messageId: "message-1",
      commandId: "command-1",
      now: 0,
      instanceName: "fix-login",
      pendingThread: true,
      reservation: { reservationId: "r1", instanceId: 501, environmentId: "env-501" },
    }),
    createKey: "k",
    createStartedAt: 1_000,
    createOperationId: 900,
    instanceId: 501,
    createRows: rows,
    ...(done
      ? {
          environmentId: "env-501",
          reservationId: "r1",
          createFinishedAt: 2_000,
          connected: true,
          connectStartedAt: 2_000,
          connectFinishedAt: 2_000,
          agentStartedAt: 2_000,
          completionOperationId: 901,
          completionStatus: "running" as const,
        }
      : {}),
  };
}

const card = (start: OrbitThreadStart) => (
  <div style={{ width: 640, padding: 16 }} data-testid="card">
    <OrbitSetupCard
      view={orbitSetupView(start)}
      onRetry={() => {}}
      onChangeName={() => {}}
      onChangeBranch={() => {}}
      onOpenInstance={() => {}}
      onDismiss={() => {}}
      onCancel={() => {}}
    />
  </div>
);

const APPROVED = [
  "Copy the container",
  "Publish the address",
  "Start the T3 server",
  "Register with Orbit",
];

it("shows only the approved rows while a reservation is finalized, and after", async () => {
  const running = observeOrbitCreateRows(
    null,
    finalize("running", [
      {
        name: "finalize-rename",
        job: null,
        status: "running",
        startedAt: null,
        finishedAt: null,
      },
    ]),
    1_100,
  );
  {
    await using screen = await render(card(reservedStart(running, false)));
    const labels = [...screen.container.querySelectorAll("[data-orbit-create-row]")].map(
      (row) => row.textContent ?? "",
    );
    expect(labels.length).toBeLessThanOrEqual(APPROVED.length);
    for (const label of labels) expect(APPROVED.some((text) => label.startsWith(text))).toBe(true);
  }
  const succeeded = observeOrbitCreateRows(
    running,
    finalize("succeeded", [
      {
        name: "finalize-rename",
        job: null,
        status: "succeeded",
        startedAt: null,
        finishedAt: null,
      },
    ]),
    2_000,
  );
  await using screen = await render(card(reservedStart(succeeded, true)));
  const statuses = [...screen.container.querySelectorAll("[data-orbit-create-row]")].map((row) =>
    row.getAttribute("data-orbit-create-status"),
  );
  // Every row done but the address, which the completion publishes.
  expect(statuses).toEqual(["done", "running", "done", "done"]);
  expect(screen.container.textContent).not.toMatch(/reserv/i);
});
