// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { IssueRichBodyEditor, IssueRichBodyView } from "./IssueRichBodyEditor";

const nativeAdfPath = new URL(
  "../../../../../packages/issue-tracker-jira/src/server/jiraAdf.ts",
  import.meta.url,
).pathname;
const { validateJiraAdf } = (await import(nativeAdfPath)) as {
  validateJiraAdf: (value: unknown) => unknown;
};

let root: Root;
let container: HTMLDivElement;
const save = vi.fn();
const cancel = vi.fn();
const native = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      attrs: { localId: "p" },
      content: [{ type: "text", text: "Editable text" }],
    },
    {
      type: "mediaSingle",
      attrs: { layout: "center" },
      content: [
        { type: "media", attrs: { id: "secret-media-id", type: "file", collection: "keep" } },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "mention", attrs: { id: "secret-person-id", text: "Somebody" } }],
    },
  ],
};
const value = { format: "adf" as const, document: JSON.stringify(native) };
const render = (props = {}) =>
  act(async () =>
    root.render(
      <IssueRichBodyEditor
        value={value}
        label="Native description"
        saving={false}
        onSave={save}
        onCancel={cancel}
        {...props}
      />,
    ),
  );
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === name,
  )!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => document.createElement("div").getClientRects(),
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  save.mockClear();
  cancel.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});

it("saves a no-op clone and labels preserved content without native IDs", async () => {
  await render();
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain("Editable text");
  expect(container.textContent).toContain("Preserved media");
  expect(container.textContent).toContain("Preserved mention");
  expect(container.textContent).not.toContain("secret-media-id");
  expect(container.textContent).not.toContain("secret-person-id");
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => button("Save").click());
  expect(JSON.parse(save.mock.calls[0]![0].document)).toEqual(native);
});

it("applies a heading through the UI and keeps unknown content", async () => {
  await render();
  await act(async () => button("Heading 3").click());
  expect(container.querySelector("h3")?.textContent).toBe("Editable text");
  await act(async () => button("Save").click());
  const next = JSON.parse(save.mock.calls[0]![0].document);
  expect(next.content[0]).toMatchObject({ type: "heading", attrs: { level: 3, localId: "p" } });
  expect(next.content.slice(1)).toEqual(native.content.slice(1));
});

it("edits text through DOM input and keeps media unchanged", async () => {
  await render();
  const text = container.querySelector('[role="textbox"] p span')!.firstChild!;
  await act(async () => {
    text.textContent = "Changed text";
    container
      .querySelector('[role="textbox"]')!
      .dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Changed text" }),
      );
  });
  await act(async () => button("Save").click());
  const next = JSON.parse(save.mock.calls[0]![0].document);
  expect(next.content[0].content[0].text).toBe("Changed text");
  expect(next.content.slice(1)).toEqual(native.content.slice(1));
});

it("keeps a draft on rerender and cancels without a write", async () => {
  await render();
  await act(async () => button("Heading 2").click());
  await render({ value: { ...value, document: JSON.stringify({ ...native, content: [] }) } });
  expect(container.querySelector("h2")?.textContent).toBe("Editable text");
  await act(async () => button("Cancel").click());
  expect(cancel).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it("disables editing and save when permission is removed", async () => {
  await render();
  await render({ disabled: true });
  expect(container.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe(
    "false",
  );
  expect(button("Save").disabled).toBe(true);
  await act(async () => button("Save").click());
  expect(save).not.toHaveBeenCalled();
});

it("formats text with the real keyboard selection and toolbar", async () => {
  await render({
    value: {
      format: "adf",
      document: JSON.stringify({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Format me",
                marks: [{ type: "textColor", attrs: { color: "#112233" } }],
              },
            ],
          },
        ],
      }),
    },
  });
  const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
  await act(async () => {
    editor.focus();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  await act(async () => button("Bold").click());
  expect(editor.querySelector("strong")?.textContent).toBe("Format me");
  await act(async () => button("Save").click());
  expect(JSON.parse(save.mock.calls[0]![0].document).content[0].content[0].marks).toEqual(
    expect.arrayContaining([
      { type: "strong" },
      { type: "textColor", attrs: { color: "#112233" } },
    ]),
  );
});

it("makes and removes a native list through the toolbar", async () => {
  await render();
  await act(async () => button("Bullet list").click());
  expect(container.querySelector("ul li p")?.textContent).toBe("Editable text");
  await act(async () => button("Save").click());
  expect(JSON.parse(save.mock.calls[0]![0].document).content[0].type).toBe("bulletList");
  await act(async () => button("Remove list").click());
  expect(container.querySelector("ul")).toBeNull();
});

it("edits a native link and retains its unknown attributes", async () => {
  const nativeLink = {
    type: "link",
    attrs: { href: "https://old.example/", id: "native-link-id", future: { keep: true } },
  };
  await render({
    value: {
      format: "adf",
      document: JSON.stringify({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Linked text", marks: [nativeLink] }],
          },
        ],
      }),
    },
  });
  const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
  await act(async () => {
    editor.focus();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  await act(async () => button("Link").click());
  const input = document.querySelector<HTMLInputElement>("#issue-rich-link")!;
  const apply = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === "Apply link",
    )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "javascript:alert(1)",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(apply().disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "https://new.example/",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => apply().click());
  await act(async () => button("Save").click());
  expect(JSON.parse(save.mock.calls[0]![0].document).content[0].content[0].marks).toEqual([
    { ...nativeLink, attrs: { ...nativeLink.attrs, href: "https://new.example/" } },
  ]);
});

it("cuts and pastes native content without flattening preserved blocks", async () => {
  await render();
  const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
  const data = new Map<string, string>();
  const clipboardData = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    clearData: () => data.clear(),
    types: ["application/x-t3-issue-adf", "text/plain"],
    files: [],
  };
  const event = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    return event;
  };
  await act(async () => {
    editor.focus();
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    editor.dispatchEvent(event("cut"));
  });
  expect(editor.textContent).not.toContain("Preserved media");
  expect(data.get("application/x-t3-issue-adf")).toContain("secret-media-id");
  await act(async () => editor.dispatchEvent(event("paste")));
  await act(async () => button("Save").click());
  expect(JSON.parse(save.mock.calls[0]![0].document)).toEqual(native);
});

it("serializes native heading level 2 after the Heading 2 toolbar action", async () => {
  await render();
  await act(async () => button("Heading 2").click());
  await act(async () => button("Save").click());
  const document = JSON.parse(save.mock.calls[0]![0].document);
  expect(document.content[0]).toMatchObject({ type: "heading", attrs: { level: 2, localId: "p" } });
  expect(document.content.slice(1)).toEqual(native.content.slice(1));
  expect(() => validateJiraAdf(document)).not.toThrow();
});

it.each([
  { initial: "strong", action: "Inline code", final: "code" },
  { initial: "code", action: "Bold", final: "strong" },
  { initial: "code", action: "Italic", final: "em" },
  { initial: "code", action: "Underline", final: "underline" },
  { initial: "code", action: "Strike", final: "strike" },
])(
  "keeps native code exclusive when $initial changes to $final through the toolbar",
  async ({ initial, action, final }) => {
    const link = { type: "link", attrs: { href: "https://example.test", native: { keep: true } } };
    const source = {
      ...native,
      content: [
        {
          type: "paragraph",
          attrs: { localId: "native-p", custom: { keep: true } },
          content: [{ type: "text", text: "Native marked text", marks: [{ type: initial }, link] }],
        },
        ...native.content.slice(1),
      ],
    };
    await render({ value: { format: "adf", document: JSON.stringify(source) } });
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => {
      editor.focus();
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await act(async () => button(action).click());
    await act(async () => button("Save").click());
    const document = JSON.parse(save.mock.calls[0]![0].document);
    expect(document.content[0].content[0].marks).toHaveLength(2);
    expect(document.content[0].content[0].marks).toEqual(
      expect.arrayContaining([{ type: final }, link]),
    );
    expect(document.content[0].attrs).toEqual(source.content[0]!.attrs);
    expect(document.content.slice(1)).toEqual(source.content.slice(1));
    expect(() => validateJiraAdf(document)).not.toThrow();
  },
);

it.each([
  "",
  "  h2. Native wiki\r\n*bold* !media-id|width=20!\r\n[Native link|https://example.test]  \r\n",
])("saves Jira wiki source unchanged without an ADF or Markdown preview", async (document) => {
  await render({ value: { format: "jira-wiki", document } });
  expect(container.textContent).toContain("Jira wiki markup");
  expect(container.querySelector("textarea")).not.toBeNull();
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
  await act(async () => button("Save").click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ format: "jira-wiki", document });
});

it.each([
  [
    "Title\r\n!attachment.png!\r\nLast\r\n",
    "Title!\n!attachment.png!\nLast\n",
    "Title!\r\n!attachment.png!\r\nLast\r\n",
  ],
  [
    "Title\r\n!attachment.png!\nLast\r\n",
    "Title\n!attachment.png!\nLast!\n",
    "Title\r\n!attachment.png!\nLast!\r\n",
  ],
  [
    "Title\r\n!attachment.png!\r\n",
    "Title\nNew\n!attachment.png!\n",
    "Title\r\nNew\r\n!attachment.png!\r\n",
  ],
  [
    "Title\r\n!attachment.png!\nLast\r\n",
    "Title\n!attachment.png!\nNew\nLast\n",
    "Title\r\n!attachment.png!\nNew\nLast\r\n",
  ],
  [
    "Title\r\nRemove\r\n!attachment.png!\r\n",
    "Title\n!attachment.png!\n",
    "Title\r\n!attachment.png!\r\n",
  ],
])(
  "preserves untouched Jira wiki line endings during textarea edits",
  async (document, next, expected) => {
    await render({ value: { format: "jira-wiki", document } });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe(document.replace(/\r\n/g, "\n"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        next,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save").click());
    expect(save).toHaveBeenCalledExactlyOnceWith({ format: "jira-wiki", document: expected });
    save.mockClear();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        textarea.value + "canceled\n",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Cancel").click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  },
);

it.each([
  { type: "textColor", attrs: { color: "#112233" } },
  { type: "subsup", attrs: { type: "sub" } },
  { type: "strong" },
  { type: "link", attrs: { href: "https://example.test" } },
])("strips $type when converting text to a native code block", async (mark) => {
  const marked = {
    type: "paragraph",
    attrs: { localId: "p" },
    content: [{ type: "text", text: "Marked text", attrs: { localId: "t" }, marks: [mark] }],
  };
  const source = {
    ...native,
    content: [marked, { ...marked, attrs: { localId: "untouched" } }, ...native.content.slice(1)],
  };
  await render({ value: { format: "adf", document: JSON.stringify(source) } });
  await act(async () => button("Code block").click());
  await act(async () => button("Save").click());
  const document = JSON.parse(save.mock.calls[0]![0].document);
  expect(document.content[0]).toMatchObject({
    type: "codeBlock",
    content: [{ type: "text", text: "Marked text", attrs: { localId: "t" } }],
  });
  expect(document.content[0].content[0].marks ?? []).toEqual([]);
  expect(document.content.slice(1)).toEqual(source.content.slice(1));
  expect(() => validateJiraAdf(document)).not.toThrow();
});

it("edits Jira wiki whitespace, syntax and media references exactly and cancels without a write", async () => {
  const value = { format: "jira-wiki", document: " h2. Native wiki\n!media-id! \n" };
  await render({ value });
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const next = "  h2. Edited wiki\n{code:java}\n x();\n{code}\n!media-id|width=40!  \n";
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      next,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ format: "jira-wiki", document: next });
  save.mockClear();
  await act(async () => button("Cancel").click());
  expect(cancel).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it("shows Jira wiki as labelled source instead of rendering Markdown", async () => {
  const document = "h2. Native heading\n*bold* !media-id!\n[Link|https://example.test]  \n";
  await act(async () =>
    root.render(<IssueRichBodyView value={{ format: "jira-wiki", document }} />),
  );
  expect(container.textContent).toContain("Jira wiki markup");
  expect(container.querySelector("pre")?.textContent).toBe(document);
  expect(container.querySelector("a, h2, strong, img")).toBeNull();
});

it("saves an empty Azure HTML description and locks it while pending or disabled", async () => {
  await render({ value: { format: "azure-html", document: "" } });
  await act(async () => button("Save").click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ format: "azure-html", document: "" });
  save.mockClear();
  await render({ value: { format: "azure-html", document: "" }, saving: true });
  expect(container.querySelector("textarea")!.disabled).toBe(true);
  expect(button("Saving…").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  await render({ value: { format: "azure-html", document: "" }, disabled: true });
  expect(container.querySelector("textarea")!.disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(false);
  await act(async () => button("Cancel").click());
  expect(cancel).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});
