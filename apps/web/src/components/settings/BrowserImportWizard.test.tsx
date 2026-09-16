import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

// Portals require a browser; keep the actual wizard and its state transitions.
vi.mock("../ui/dialog", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => children;
  return Object.fromEntries(
    [
      "Dialog",
      "DialogClose",
      "DialogDescription",
      "DialogFooter",
      "DialogHeader",
      "DialogPanel",
      "DialogPopup",
      "DialogTitle",
    ].map((name) => [name, Wrapper]),
  );
});

import { BrowserImportWizard } from "./BrowserImportWizard";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("expands and collapses the skipped domains after importing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const domains = Array.from({ length: 20 }, (_, index) => `domain${index}.com`);
  await act(() => {
    renderer = create(
      <BrowserImportWizard
        source={{
          id: "chrome",
          name: "Chrome",
          profiles: [{ directory: "Default", name: "Default" }],
        }}
        destinationEnvironmentName="Local"
        targetProfiles={[]}
        canCreateProfile
        onImport={async () => ({
          kind: "imported",
          imported: 1,
          skipped: 20,
          skippedDomains: domains,
          targetName: "New profile",
        })}
        onRefreshSource={async () => undefined}
        onOpenFullDiskAccessSettings={() => {}}
        onClose={() => {}}
      />,
    );
  });
  const button = (label: string) =>
    renderer!.root.findAllByType("button").find((node) => node.children.join("") === label);
  await act(async () => button("Import")!.props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("domain19.com");
  expect(button("17 more")).toBeDefined();
  await act(() => button("17 more")!.props.onClick());
  for (const domain of domains) expect(JSON.stringify(renderer!.toJSON())).toContain(domain);
  expect(button("Show less")!.props["aria-expanded"]).toBe(true);
  await act(() => button("Show less")!.props.onClick());
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("domain19.com");
  expect(button("17 more")!.props["aria-expanded"]).toBe(false);
});
