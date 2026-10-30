import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";
import Pdf from "react-native-pdf-jsi";

import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";
import { pdfInitialPage, pdfLinkUrl, preparePdfPreview } from "../lib/pdfPreview";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { ControlPill } from "./ui/ControlPill";

const preparedPdfAtom = Atom.family((uri: string) =>
  Atom.make(
    // The downloaded copy lives as long as a viewer reads it; Retry refreshes the atom,
    // which closes the scope and discards the copy before downloading again. Acquisition
    // stays interruptible so closing the viewer aborts the download.
    Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) => {
          const prepared = preparePdfPreview(uri, signal);
          // An interrupt can land after the copy exists but before acquireRelease owns it.
          signal.addEventListener("abort", () => {
            void prepared.then(
              (file) => file?.dispose(),
              () => undefined,
            );
          });
          return prepared;
        },
        catch: (cause) => (cause instanceof Error ? cause.message : "The PDF could not be loaded."),
      }).pipe(
        Effect.flatMap((file) => (file === null ? Effect.interrupt : Effect.succeed(file))),
        Effect.interruptible,
      ),
      (file) => Effect.sync(file.dispose),
    ),
  ).pipe(Atom.withLabel(`android-pdf-preview:${uri}`)),
);

export function PdfPreview(props: { readonly uri: string }) {
  const atom = preparedPdfAtom(props.uri);
  const prepared = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  // A render failure belongs to the downloaded copy that failed; Retry replaces it.
  const [unrenderable, setUnrenderable] = useState<unknown>(null);
  const file = prepared._tag === "Success" && !prepared.waiting ? prepared.value : null;
  const error =
    file !== null && unrenderable === file
      ? "The PDF could not be rendered. It may be damaged or password protected."
      : prepared._tag === "Failure" && !prepared.waiting
        ? Option.getOrElse(AsyncResult.error(prepared), () => "The PDF could not be loaded.")
        : null;
  const localUri = file?.uri ?? null;

  if (error) {
    return (
      <View className="flex-1 gap-4 bg-card">
        <FilePreviewNotice title="Could not load PDF">{error}</FilePreviewNotice>
        <View className="items-center">
          <ControlPill label="Try again" variant="pill" onPress={refresh} />
        </View>
      </View>
    );
  }
  if (localUri === null) return <FilePreviewLoading message="Loading PDF..." background="card" />;

  return (
    <Pdf
      source={{ uri: localUri }}
      page={pdfInitialPage(props.uri)}
      fitPolicy={0}
      trustAllCerts={false}
      enableAnnotationRendering
      enableDoubleTapZoom
      onPressLink={(href) => {
        const url = pdfLinkUrl(href, props.uri);
        if (url !== null) void tryOpenExternalUrl(url, "file-preview");
      }}
      onError={() => {
        setUnrenderable(file);
      }}
      style={{ flex: 1, width: "100%" }}
    />
  );
}
