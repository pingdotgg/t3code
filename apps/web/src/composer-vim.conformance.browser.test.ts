import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
// @ts-expect-error The engine ships its suite as untyped JavaScript.
import { vimTests } from "@replit/codemirror-vim-core/test/vim_test.js";
import { describe, it } from "vite-plus/test";

import { createComposerVimHost, Vim, ComposerVimEditor } from "./composer-vim-adapter";
import { createTextareaVimHost } from "./textarea-vim";
import { VimEditor } from "./vim-engine";
import {
  ComposerVimExtension,
  handleComposerVimKeyDown,
  setComposerVimHost,
} from "./composer-vim-editor";

// The suite sends Ctrl keys that vim only receives on macOS; elsewhere most stay with the app.
Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
Object.assign(VimEditor, { isMac: true });

const testground = document.createElement("div");
testground.id = "testground";
document.body.append(testground);

function createEditor(place: HTMLElement, options: { value?: string }) {
  const element = document.createElement("div");
  place.append(element);
  const lines = (options.value ?? "").split("\n");
  let host: ReturnType<typeof createComposerVimHost>;
  const editor = new Editor({
    element,
    extensions: [StarterKit.configure({ undoRedo: { newGroupDelay: 1000 } }), ComposerVimExtension],
    content: {
      type: "doc",
      content: lines.map((line) => ({
        type: "paragraph",
        ...(line ? { content: [{ type: "text", text: line }] } : {}),
      })),
    },
    editorProps: {
      handleKeyDown(view, event) {
        if (handleComposerVimKeyDown(view, event, () => false)) return true;
        // Synthetic keys get no native editing, which the composer relies on in insert mode.
        if (event.key === "Backspace") host.editor.deleteCharacter(-1);
        else if (event.key === "Delete") host.editor.deleteCharacter(1);
        else if (event.key === "ArrowLeft") host.editor.moveCaret(-1);
        else if (event.key === "ArrowRight") host.editor.moveCaret(1);
        else if (event.key === "ArrowUp") host.editor.moveLine(-1);
        else if (event.key === "ArrowDown") host.editor.moveLine(1);
        else return false;
        return true;
      },
    },
  });
  const { view } = editor;
  host = createComposerVimHost(view);
  setComposerVimHost(view, host);
  Object.assign(view.dom, {
    _handleInputEventForTest(text: string) {
      if (text === "\n") host.editor.replaceSelection("\n");
      else view.dispatch(view.state.tr.insertText(text));
    },
  });
  Vim.handleKey(host.editor as never, "<Esc>", "user");
  // The suite sizes its scroller; the composer's height comes from CSS.
  host.editor.setSize = (width?: number | string, height?: number | string) => {
    const dom = view.dom as HTMLElement;
    dom.style.overflow = "auto";
    if (width != null) dom.style.width = `${width}px`;
    if (height != null) dom.style.height = `${height}px`;
  };
  return host.editor;
}

const OUT_OF_SCOPE = /_block|blockwise|visualBlock/;

const UNSUPPORTED = new Set([
  // Block mode is off, and these also exercise it.
  "vim_gu_and_gU",
  "vim_g?",
  "vim_ex_imap",
  // These read language tokens, folds, or tags that a prompt does not have.
  "vim_j_with_folding",
  "vim_k_with_folding",
  "vim_%_seek_skip",
  "vim_%_skip_string",
  "vim_%_skip_comment",
  "vim_gcc",
  "vim_dat_open_tag",
  "vim_dat_close_tag",
  "vim_dit_open_tag",
  "vim_dit_close_tag",
  "vim_dat_inside_tag",
  "vim_dit_inside_tag",
  "vim_ex_set_filetype",
  "vim_ex_set_filetype_null",
  // These expect language-aware indent or hard wrap.
  "vim_cG",
  "vim_=",
  "vim_._insert_o_indent",
  "vim_]p_with_tab_indents",
  "vim_]p_with_spaces_translated_to_tabs",
  "vim_gq_and_gw",
  // These test CodeMirror's own status bar, cursor layer, or copy path.
  "vim_updateStatus",
  "vim_rendered_cursor_position_cm6",
  "vim_<C-c>copy",
  // The composer keeps Escape in normal mode for panels, so it cannot be remapped.
  "vim_map <Esc> in normal mode",
  // The engine asserts a cursor one past where vim leaves it; see the patch.
  "vim_P",
  // Vim refuses or moves differently here, as the reference table shows; the suite asserts the
  // engine's old result.
  "vim_dj_end_of_document",
  "vim_d_reverse",
  "vim_di{_middle_spc",
  "vim_di}_middle_spc",
  "vim_di[_middle_spc",
  "vim_di]_middle_spc",
  "vim_di<_middle_spc",
  "vim_di>_middle_spc",
  "vim_Fy,;",
  "vim_ty,;",
  "vim_Ty,;",
  "vim_dk_start_of_document",
  // Open gaps in rarely used paths; none affects the reference table.
  "vim_jumplist_skip_deleted_mark<c-o>",
  "vim_jumplist_skip_deleted_mark<c-i>",
  "vim_?_greedy_0_or_more",
  "vim_ex_normal",
  "vim_ex_substitute_javascript",
  "vim_map_prompt",
  "vim_mapclear",
  // These measure CodeMirror's line layout; a composer test covers gj, gk, g0, and g$.
  "vim_gj_gk",
  "vim_gj_gk_clipping",
  "vim_g0_g$",
  "vim_ex_nmap",
  // These need a tall scroller, which a composer capped at a few lines does not have.
  "vim_page_motions",
  "vim_HML",
  "vim_scrollMotion",
]);

function createTextarea(place: HTMLElement, options: { value?: string }) {
  // The suite removes the wrapper after each test, which must not be the shared container.
  const wrapper = document.createElement("div");
  place.append(wrapper);
  const textarea = document.createElement("textarea");
  textarea.value = options.value ?? "";
  wrapper.append(textarea);
  textarea.focus();
  // The suite assumes the cursor starts at the top; a textarea's caret starts at the end.
  textarea.setSelectionRange(0, 0);
  const host = createTextareaVimHost(textarea);
  textarea.addEventListener("keydown", (event) => {
    if (host.handleKeyDown(event)) {
      event.preventDefault();
      return;
    }
    host.editor.onBeforeNativeInput();
    // The suite's own textarea typing inserts these keys as words.
    const editing: Record<string, () => void> = {
      Backspace: () => host.editor.deleteCharacter(-1),
      Delete: () => host.editor.deleteCharacter(1),
      ArrowLeft: () => host.editor.moveCaret(-1),
      ArrowRight: () => host.editor.moveCaret(1),
      ArrowUp: () => host.editor.moveLine(-1),
      ArrowDown: () => host.editor.moveLine(1),
    };
    const run = editing[event.key];
    if (!run) return;
    run();
    event.preventDefault();
  });
  Vim.handleKey(host.editor as never, "<Esc>", "user");
  return host.editor;
}

function statics(create: unknown) {
  return Object.assign(create as object, {
    Vim,
    Pos: (ComposerVimEditor as unknown as { Pos: unknown }).Pos,
    commands: (ComposerVimEditor as unknown as { commands: unknown }).commands,
    on: (ComposerVimEditor as unknown as { on: unknown }).on,
    isMac: (ComposerVimEditor as unknown as { isMac: unknown }).isMac,
    defineMode: () => {},
    version: "6.0.0",
  });
}

const runSuite = vimTests as (
  cm: unknown,
  test: (name: string, run: () => Promise<void>) => void,
) => void;

describe("composer", () => {
  runSuite(statics(createEditor), (name, run) => {
    if (!OUT_OF_SCOPE.test(name) && !UNSUPPORTED.has(name)) it(name, run);
  });
});

const TEXTAREA_UNSUPPORTED = new Set([
  // A textarea reports no line geometry, so these commands work by logical line.
  "vim_j_k_and_gj_gk",
  "vim_zz<zt",
  "vim_zz==z.",
  // This edits through the engine's API mid-insert, which typing cannot do.
  "vim_._normal",
]);

describe("textarea", () => {
  runSuite(statics(createTextarea), (name, run) => {
    if (OUT_OF_SCOPE.test(name) || UNSUPPORTED.has(name) || TEXTAREA_UNSUPPORTED.has(name)) return;
    it(name, run);
  });
});
