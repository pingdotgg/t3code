import { expect, it } from "vite-plus/test";

import { studyKey } from "./studyKeys";

const press = (html: string, key: string, init: KeyboardEventInit = {}) => {
  const page = document.createElement("div");
  page.innerHTML = html;
  document.body.append(page);
  let result: ReturnType<typeof studyKey>;
  const listen = (event: KeyboardEvent) => {
    result = studyKey(event);
  };
  window.addEventListener("keydown", listen, { once: true });
  (page.querySelector("[data-target]") ?? page).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
  page.remove();
  return result;
};

it("flips, rates and closes from the page", () => {
  expect(press("", " ")).toBe("flip");
  expect(press("", "Enter")).toBe("flip");
  expect(press("", "1")).toBe("again");
  expect(press("", "4")).toBe("easy");
  expect(press("", "5")).toBeUndefined();
  expect(press("", "Escape")).toBe("close");
});

it("leaves Space and Enter to the focused control", () => {
  for (const html of [
    "<button data-target></button>",
    "<button><span data-target></span></button>",
    '<a href="/" data-target></a>',
    '<div role="button" data-target></div>',
  ]) {
    expect(press(html, " ")).toBeUndefined();
    expect(press(html, "Enter")).toBeUndefined();
    expect(press(html, "3")).toBe("good");
  }
});

it("leaves every key to a text field, and shortcuts to the browser", () => {
  for (const html of [
    "<textarea data-target></textarea>",
    "<div contenteditable data-target></div>",
  ]) {
    expect(press(html, " ")).toBeUndefined();
    expect(press(html, "1")).toBeUndefined();
  }
  expect(press("", "1", { ctrlKey: true })).toBeUndefined();
});
