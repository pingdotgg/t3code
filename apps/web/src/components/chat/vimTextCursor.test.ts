import { expect, it } from "vite-plus/test";
import { createVimTextCursor } from "./vimTextCursor";

it("selects and yanks a paragraph linewise, with the available blank lines for ap", () => {
  const text = "first\nline\n\nlast\nline";
  const cursor = createVimTextCursor(text);
  cursor.setPosition(7);
  cursor.select(cursor.object("p", false)!);
  expect(cursor.contents(cursor.selection())).toBe("first\nline\n");
  expect(cursor.contents(cursor.object("p", true)!)).toBe("first\nline\n\n");
  cursor.setPosition(text.length - 1);
  expect(cursor.contents(cursor.object("p", true)!)).toBe("\nlast\nline\n");
});

it("uses Vim word boundaries for mixed-script code and whitespace boundaries for WORD", () => {
  const cursor = createVimTextCursor("运行build_step.结果  now");
  cursor.move("w");
  expect(cursor.contents(cursor.object("w", false)!)).toBe("build_step");
  expect(cursor.contents(cursor.object("W", true)!)).toBe("运行build_step.结果  ");
  cursor.move("e");
  expect(cursor.yankMotion("l")).toBe("p");
});

it("yanks through the end of a line without consuming the character after a word", () => {
  const cursor = createVimTextCursor("a x\nZ");
  expect(cursor.yankMotion("w")).toBe("a ");
  cursor.move("w");
  expect(cursor.yankMotion("l")).toBe("x");
  expect(cursor.yankMotion("w")).toBe("x");
  expect(cursor.yankMotion("y")).toBe("a x\n");
});
