import { expect, it } from "vite-plus/test";

import "~/index.css";

function mount(html: string) {
  const host = document.createElement("div");
  host.style.width = "600px";
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

function wordLeft(element: Element, word: string) {
  const text = [...element.childNodes].find((node) => node.textContent?.includes(word))!;
  const range = document.createRange();
  const start = text.textContent!.indexOf(word);
  range.setStart(text, start);
  range.setEnd(text, start + word.length);
  return range.getBoundingClientRect().left;
}

it("gives plain text its own base direction", () => {
  const host = mount(`<span id="he">באג: fix parser</span><p id="en">Fix: באג parser</p>`);
  const he = host.querySelector("#he")!;
  const en = host.querySelector("#en")!;
  expect(getComputedStyle(he).unicodeBidi).toBe("plaintext");
  expect(wordLeft(he, "באג")).toBeGreaterThan(wordLeft(he, "fix"));
  expect(wordLeft(en, "Fix")).toBeLessThan(wordLeft(en, "parser"));
  host.remove();
});

it("leaves explicit dir, code and editors alone", () => {
  const host = mount(
    `<div dir="ltr"><p id="dir">שלום</p><span id="inline">שלום</span></div><pre><span id="pre">// הערה</span></pre>` +
      `<code id="code">x</code><div contenteditable><span id="edit">שלום</span></div>`,
  );
  for (const id of ["dir", "inline", "pre", "code", "edit"]) {
    expect(getComputedStyle(host.querySelector(`#${id}`)!).unicodeBidi, id).not.toBe("plaintext");
  }
  host.remove();
});
