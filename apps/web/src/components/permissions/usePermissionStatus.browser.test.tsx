import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { usePermissionStatus } from "./usePermissionStatus";

function PermissionProbe({
  check,
  label,
  enabled = true,
}: {
  readonly check: () => Promise<{ screen: boolean }>;
  readonly label: string;
  readonly enabled?: boolean;
}) {
  const { status } = usePermissionStatus(async () => check(), { screen: false }, enabled);
  return (
    <p>
      {label}: {status.screen ? "granted" : "missing"}
    </p>
  );
}

describe("usePermissionStatus", () => {
  it("does not start a new check when the component re-renders", async () => {
    // A check that never settles keeps the interval from adding calls, so any
    // extra call can only come from the subscription restarting.
    const check = vi.fn(() => new Promise<{ screen: boolean }>(() => {}));
    await using screen = await render(<PermissionProbe check={check} label="first" />, {
      router: false, // the hook does not touch routing
    });
    await screen.rerender(<PermissionProbe check={check} label="second" />);
    await screen.rerender(<PermissionProbe check={check} label="third" />);

    await expect.element(screen.getByText("third: missing")).toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks with the latest check after the caller passes a new one", async () => {
    const first = vi.fn(() => new Promise<{ screen: boolean }>(() => {}));
    const second = vi.fn(async () => ({ screen: true }));
    await using screen = await render(<PermissionProbe check={first} label="probe" />, {
      router: false, // the hook does not touch routing
    });
    await screen.rerender(<PermissionProbe check={second} label="probe" enabled={false} />);
    await screen.rerender(<PermissionProbe check={second} label="probe" />);

    await expect.element(screen.getByText("probe: granted")).toBeInTheDocument();
    expect(first).toHaveBeenCalledTimes(1);
  });
});
