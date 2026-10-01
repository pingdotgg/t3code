// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ToastProvider, toastManager } from "./toast";
import {
  beginPullRequestCheckoutToast,
  pullRequestCheckoutErrorDetail,
} from "../pullRequest/pullRequestHandoffToast";
import { SourceControlProviderError } from "@t3tools/contracts";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => undefined,
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const toastIds: ReturnType<typeof toastManager.add>[] = [];
const checkoutToasts: ReturnType<typeof beginPullRequestCheckoutToast>[] = [];
afterEach(async () => {
  await act(async () => {
    for (const id of toastIds.splice(0)) toastManager.close(id);
    for (const checkout of checkoutToasts.splice(0)) checkout.close();
    root.render(null);
  });
});

it("does not add a disclosure to unrelated long error descriptions", async () => {
  const detail = "An unrelated error with a long diagnostic body. ".repeat(6);
  await act(async () => {
    root.render(<ToastProvider />);
  });
  await act(async () => {
    toastIds.push(
      toastManager.add({ type: "error", title: "Request failed", description: detail }),
    );
  });
  expect(document.querySelector("[data-slot=toast-description]")?.textContent).toBe(detail);
  expect(
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Show details"),
    ),
  ).toBe(false);
});

it("reveals a split-host checkout detail only when the checkout caller opts in", async () => {
  // Stress both flags with a port; server-generated --hostname normally omits it.
  const detail =
    "If private, run `glab auth login --hostname gitlab.127.0.0.1.nip.io:18880 --api-host gitlab.127.0.0.1.nip.io:18880` and retry. Merge request !1 was not found or is inaccessible on gitlab.127.0.0.1.nip.io:18880.";
  const error = new SourceControlProviderError({
    provider: "gitlab",
    operation: "getChangeRequest",
    cwd: "/repo",
    detail,
  });
  await act(async () => {
    root.render(<ToastProvider />);
  });
  await act(async () => {
    const checkout = beginPullRequestCheckoutToast();
    checkoutToasts.push(checkout);
    checkout.settle({ kind: "checkout-failed", detail: pullRequestCheckoutErrorDetail(error) });
  });
  const disclosure = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Show details"),
  );
  expect(disclosure).toBeDefined();
  await act(async () => {
    disclosure!.click();
  });
  expect(disclosure!.getAttribute("aria-expanded")).toBe("true");
  expect(disclosure!.parentElement?.textContent).toContain(detail);
  await act(async () => {
    disclosure!.click();
  });
  expect(disclosure!.getAttribute("aria-expanded")).toBe("false");
  expect(disclosure!.parentElement?.textContent).not.toContain(detail);
});

it("keeps short checkout errors compact without a disclosure", async () => {
  await act(async () => {
    root.render(<ToastProvider />);
  });
  await act(async () => {
    const checkout = beginPullRequestCheckoutToast();
    checkoutToasts.push(checkout);
    checkout.settle({
      kind: "checkout-failed",
      detail: "Check the MR number or URL and try again.",
    });
  });
  expect(
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Show details"),
    ),
  ).toBe(false);
});
