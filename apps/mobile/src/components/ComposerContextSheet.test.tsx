import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ComposerContextId, EnvironmentId, type ComposerContextRecord } from "@t3tools/contracts";

import type { FilePreviewModalProps, FilePreviewViewerProps } from "./ui/FilePreviewModal.types";

const harness = vi.hoisted(() => ({ presentations: 0, finished: false }));

vi.mock("./ui/FilePreviewModal", async () => {
  const { FilePreviewSession } = await import("./ui/FilePreviewSession");
  // Stands in for the native viewer: each mount is one presentation.
  function Viewer(props: FilePreviewViewerProps) {
    useState(() => harness.presentations++);
    const { onPresent } = props;
    useEffect(() => onPresent?.(() => harness.finished), [onPresent]);
    return null;
  }
  return {
    FilePreviewModal: (props: FilePreviewModalProps) => (
      <FilePreviewSession {...props} progressiveGallery Viewer={Viewer} />
    ),
  };
});
vi.mock("../state/assets", () => ({
  refreshAssetUrl: async () => "https://signed.test/image.png",
  useRefreshAssetUrl: () => async () => "https://signed.test/image.png",
}));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./ui/Button", () => ({ Button: () => null }));
vi.mock("./ui/AppText", () => ({ AppText: ({ children }: { children?: ReactNode }) => children }));
vi.mock("./ui/Sheet", () => ({ Sheet: () => null }));
vi.mock("./ui/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("./ComposerContextAttachment", () => ({ ComposerContextAttachment: () => null }));
vi.mock("../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => vi.fn() }));
vi.mock("../features/files/SourceFileSurface", () => ({ SourceFileSurface: () => null }));
vi.mock("../features/review/ReviewCommentCard", () => ({
  ReviewCommentCard: () => null,
  useReviewCommentColors: () => ({}),
}));
vi.mock("../features/review/reviewCommentSelection", () => ({ reviewCommentRangeText: vi.fn() }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeId: "default", themeAppearance: "dark" }),
}));
vi.mock("../features/terminal/terminalTheme", () => ({ getMobileTerminalTheme: () => ({}) }));
vi.mock("@t3tools/client-runtime/source-control-clients", () => ({
  sourceControlClients: { findByChangeRequestUrl: () => undefined, get: () => ({}) },
}));
vi.mock("../lib/changeRequestTerm", () => ({ changeRequestTermKind: () => "pull-request" }));
vi.mock("react-native", () => ({
  Pressable: () => null,
  ScrollView: () => null,
  View: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));
vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));

import { ComposerContextSheet } from "./ComposerContextSheet";

const imageRecord = (id: string): ComposerContextRecord => ({
  version: 1,
  kind: "image",
  contextId: ComposerContextId.make(id),
  label: `${id}.png`,
  attachmentId: id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 3,
});

it("presents a chip's image once across re-renders and a newly selected chip's image", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const first = imageRecord("first");
  const second = imageRecord("second");
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
  // A draft update, such as an upload landing, hands the open sheet new props.
  const render = (record: ComposerContextRecord) =>
    act(async () =>
      root.render(
        <ComposerContextSheet
          label={record.label}
          record={record}
          records={[first, second]}
          attachments={[]}
          environmentId={EnvironmentId.make("environment")}
          onClose={() => {}}
        />,
      ),
    );
  await render(first);
  expect(harness.presentations).toBe(1);

  // The native viewer has closed, but its close has not reached the sheet yet.
  harness.finished = true;
  await render(first);
  expect(harness.presentations).toBe(1);

  // Tapping another chip before that close lands replaces the selection without unmounting.
  await render(second);
  expect(harness.presentations).toBe(2);
});
