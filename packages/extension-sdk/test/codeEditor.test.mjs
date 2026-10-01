import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { resolveCodeEditor } from "../dist/environment.js";

NodeTest.test("editable code view resolves the optional Editor member on a compatible host", () => {
  const File = () => null;
  const Diff = () => null;
  const Editor = () => null;
  NodeAssert.equal(resolveCodeEditor({}), null);
  NodeAssert.equal(resolveCodeEditor({ codeView: { version: 0, File, Diff, Editor } }), null);
  NodeAssert.equal(resolveCodeEditor({ codeView: { version: 1, File, Diff } }), null);
  NodeAssert.equal(resolveCodeEditor({ codeView: { version: 1, File, Diff, Editor: {} } }), null);
  NodeAssert.equal(resolveCodeEditor({ codeView: { version: 1, File, Diff, Editor } }), Editor);
});
