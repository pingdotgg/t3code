import { getSchemaByResolvedExtensions, resolveExtensions } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerListExtensions,
} from "./composer-rich-text-doc";
import { composerTextDirections } from "./composer-text-direction";

const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      code: false,
    }),
    ComposerCodeExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
  ]),
);

function directions(value: string) {
  const doc = ProseMirrorNode.fromJSON(
    schema,
    buildDocJson(value, (name) => ({ label: name, description: null })),
  );
  return composerTextDirections(doc).blocks;
}

describe("composerTextDirections", () => {
  it("does not count inline code toward a line's direction", () => {
    expect(directions("`useEffect` و `useLayoutEffect` في `React`")).toEqual(["rtl"]);
  });

  it("gives a list one direction, from all of its items", () => {
    expect(directions("- Vitest\n- اختبر الدالة الجديدة\n- وأضف تعليق")).toEqual(["rtl"]);
  });

  it("continues the line above until a line has letters", () => {
    expect(directions("اكتب الدالة\n\n42\nfix it")).toEqual(["rtl", "rtl", "rtl", "ltr"]);
  });

  it("keeps a code block left to right inside Arabic text", () => {
    expect(directions("اكتب الدالة\n```\n// احسب مجموع القيم هنا\n```\nثم اختبرها")).toEqual([
      "rtl",
      "ltr",
      "rtl",
    ]);
  });
});
