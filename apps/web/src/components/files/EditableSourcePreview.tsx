import type { Editor } from "@pierre/diffs/editor";
import { EditProvider, File, Virtualizer, type FileProps } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { SOURCE_PREVIEW_VIRTUALIZER_CONFIG } from "./fileSurfaceChrome";

export function EditableSourcePreview<Metadata>(props: {
  readonly editor: Editor<Metadata>;
  readonly fileProps: FileProps<Metadata>;
}) {
  return (
    <DiffWorkerPoolProvider>
      <EditProvider editor={props.editor}>
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={SOURCE_PREVIEW_VIRTUALIZER_CONFIG}
        >
          <File {...props.fileProps} className="min-h-full" contentEditable />
        </Virtualizer>
      </EditProvider>
    </DiffWorkerPoolProvider>
  );
}
