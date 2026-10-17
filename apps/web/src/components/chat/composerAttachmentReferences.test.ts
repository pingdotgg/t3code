import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  composerTargetKey,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { imageContextReference } from "../../lib/composerContextRecords";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import { insertAttachmentReferencesForDraft } from "./composerAttachmentReferences";

afterEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
});

describe("async attachment references", () => {
  it.each(["thread", "environment"])(
    "keeps a deferred image in its original draft after a %s switch",
    async (switchKind) => {
      const targetA = scopeThreadRef(EnvironmentId.make("env-A"), ThreadId.make("thread-A"));
      const targetB = scopeThreadRef(
        EnvironmentId.make(switchKind === "environment" ? "env-B" : "env-A"),
        ThreadId.make(switchKind === "environment" ? "thread-A" : "thread-B"),
      );
      const store = useComposerDraftStore.getState();
      store.setPrompt(targetA, "Draft A original");
      store.setPrompt(targetB, "Draft B original");
      let liveTargetKey = composerTargetKey(targetA);
      const promptRef = { current: "Draft A original" };
      const editor = { text: promptRef.current, caret: 4 };
      const insertReferences = vi.fn(() => {
        const next = ensureInlineContextReferences(promptRef.current, [
          imageContextReference(image),
        ]);
        store.setPrompt(targetA, next);
        promptRef.current = next;
        editor.text = next;
        editor.caret = next.length;
        return true;
      });
      const image: ComposerImageAttachment = {
        type: "image",
        id: "image-1",
        name: "picture.png",
        mimeType: "image/png",
        sizeBytes: 3,
        file: new File(["png"], "picture.png", { type: "image/png" }),
        previewUrl: "blob:picture",
      };
      let finishCompression!: (image: ComposerImageAttachment) => void;
      const compression = new Promise<ComposerImageAttachment>((resolve) => {
        finishCompression = resolve;
      });
      const pending = compression.then((compressed) => {
        const accepted = store.addImages(targetA, [compressed]);
        expect(accepted).toEqual([image.id]);
        return insertAttachmentReferencesForDraft({
          target: targetA,
          liveAttachmentTargetKey: liveTargetKey,
          references: [imageContextReference(compressed)],
          insertReferences,
        });
      });

      liveTargetKey = composerTargetKey(targetB);
      promptRef.current = "Draft B original";
      editor.text = promptRef.current;
      // Use the latest stored A prompt, including edits from elsewhere during compression.
      store.setPrompt(targetA, "Draft A original updated");
      finishCompression(image);
      expect(await pending).toBe(true);

      expect(store.getComposerDraft(targetA)?.prompt).toBe(
        ensureInlineContextReferences("Draft A original updated", [imageContextReference(image)]),
      );
      expect(store.getComposerDraft(targetA)?.images).toEqual([image]);
      expect(store.getComposerDraft(targetB)?.prompt).toBe("Draft B original");
      expect(store.getComposerDraft(targetB)?.images).toEqual([]);
      expect(promptRef.current).toBe("Draft B original");
      expect(editor).toEqual({ text: "Draft B original", caret: 4 });
      expect(insertReferences).not.toHaveBeenCalled();
    },
  );
});
