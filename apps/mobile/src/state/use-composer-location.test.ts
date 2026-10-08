import * as NodeModule from "node:module";
import { act, createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { DraftComposerLocationAttachment } from "../lib/sharedLocation";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), append: vi.fn() }));
vi.mock("../lib/sharedLocation", () => ({ pickCurrentLocation: mocks.pick }));
vi.mock("./use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => ({ attachments: [] }),
  appendComposerDraftAttachments: mocks.append,
}));

import { useComposerLocation } from "./use-composer-location";

const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): {
    render(children: ReactNode): void;
    unmount(): void;
  };
};

const location: DraftComposerLocationAttachment = {
  id: "location",
  type: "location",
  name: "Main Library",
  address: "100 Larkin St, San Francisco, CA",
  latitude: 37.7793,
  longitude: -122.4192,
  accuracy: 12,
};
let root: ReturnType<typeof createRoot>;
let current: ReturnType<typeof useComposerLocation>;

function Probe({ draftKey }: { draftKey: string }) {
  const value = useComposerLocation(draftKey, true);
  useEffect(() => {
    current = value;
  });
  return null;
}

function render(draftKey: string) {
  return act(() => root.render(createElement(Probe, { draftKey })));
}

function deferredLocation() {
  let resolve!: (value: DraftComposerLocationAttachment) => void;
  const promise = new Promise<DraftComposerLocationAttachment>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.pick.mockReset();
  mocks.append.mockReset().mockReturnValue(0);
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("allows a new lookup after leaving and returning to a draft, ignoring the cancelled fix", async () => {
  const first = deferredLocation();
  const second = deferredLocation();
  mocks.pick.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render("draft-a");
  let oldRequest!: Promise<void>;
  await act(() => {
    oldRequest = current.pickLocation();
  });
  expect(current.busy).toBe(true);
  await render("draft-b");
  await render("draft-a");
  expect(current.busy).toBe(false);

  let newRequest!: Promise<void>;
  await act(() => {
    newRequest = current.pickLocation();
  });
  await act(async () => {
    first.resolve(location);
    await oldRequest;
  });
  expect(mocks.append).not.toHaveBeenCalled();
  expect(current.busy).toBe(true);
  await act(async () => {
    second.resolve(location);
    await newRequest;
  });
  expect(mocks.append).toHaveBeenCalledExactlyOnceWith("draft-a", [location]);
  expect(current.busy).toBe(false);
});

it("reports denied permission without attaching a partial fix", async () => {
  mocks.pick.mockRejectedValue(new Error("Location permission was denied."));
  await render("draft-a");
  await act(async () => {
    await current.pickLocation();
  });
  expect(current.error).toBe("Location permission was denied.");
  expect(current.busy).toBe(false);
  expect(mocks.append).not.toHaveBeenCalled();
});

it("does not retain a fix after the composer unmounts", async () => {
  const pending = deferredLocation();
  mocks.pick.mockReturnValue(pending.promise);
  await render("draft-a");
  let request!: Promise<void>;
  await act(() => {
    request = current.pickLocation();
  });
  await act(() => root.unmount());
  pending.resolve(location);
  await request;
  expect(mocks.append).not.toHaveBeenCalled();
});
