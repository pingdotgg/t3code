import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderInstanceEntry } from "../../providerInstances";

let capturedExtraData: unknown;

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: { extraData?: unknown }) => {
    capturedExtraData = props.extraData;
    return null;
  },
}));

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { favorites: never[] }) => unknown) =>
    selector({ favorites: [] }),
  useUpdateClientSettings: () => () => {},
}));

vi.mock("../ui/combobox", () => ({
  Combobox: (props: { children?: ReactNode }) => props.children,
  ComboboxEmpty: (props: { children?: ReactNode }) => props.children,
  ComboboxInput: () => null,
  ComboboxListVirtualized: (props: { children?: ReactNode }) => props.children,
}));

vi.mock("../ui/tooltip", () => ({
  TooltipProvider: (props: { children?: ReactNode }) => props.children,
}));

vi.mock("./ModelListRow", () => ({
  ModelListRow: () => null,
}));

vi.mock("./ModelPickerSidebar", () => ({
  ModelPickerSidebar: () => null,
}));

vi.mock("../../providerInstances", () => ({
  isProviderInstancePickerReady: () => true,
  isProviderInstancePickerVisible: () => true,
}));

let ModelPickerContent: typeof import("./ModelPickerContent").ModelPickerContent;

beforeAll(async () => {
  vi.stubGlobal("navigator", { platform: "Linux", userAgent: "T3 Code test" });
  ({ ModelPickerContent } = await import("./ModelPickerContent"));
});

describe("ModelPickerContent", () => {
  it("invalidates virtualized rows when positional shortcut labels change", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driverKind = ProviderDriverKind.make("codex");

    renderToStaticMarkup(
      <ModelPickerContent
        activeInstanceId={instanceId}
        model="gpt-5.6-sol"
        lockedProvider={null}
        instanceEntries={
          [
            {
              instanceId,
              driverKind,
              displayName: "Codex",
              enabled: true,
              installed: true,
              status: "ready",
              isDefault: true,
              isAvailable: true,
              snapshot: {} as never,
              models: [],
            },
          ] satisfies ReadonlyArray<ProviderInstanceEntry>
        }
        keybindings={[
          {
            shortcut: {
              key: "1",
              metaKey: false,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: true,
            },
            command: "modelPicker.jump.1",
            whenAst: { type: "identifier", name: "modelPickerOpen" },
          },
          {
            shortcut: {
              key: "2",
              metaKey: false,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: true,
            },
            command: "modelPicker.jump.2",
            whenAst: { type: "identifier", name: "modelPickerOpen" },
          },
        ]}
        modelOptionsByInstance={
          new Map([
            [
              instanceId,
              [
                { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
                { slug: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
              ],
            ],
          ])
        }
        terminalOpen={false}
        onInstanceModelChange={() => {}}
      />,
    );

    expect(capturedExtraData).toEqual(
      expect.objectContaining({
        activeInstanceId: instanceId,
        activeModel: "gpt-5.6-sol",
        modelJumpLabelByKey: new Map([
          [`${instanceId}:gpt-5.6-sol`, "Ctrl+1"],
          [`${instanceId}:gpt-5.6-luna`, "Ctrl+2"],
        ]),
      }),
    );
  });
});
