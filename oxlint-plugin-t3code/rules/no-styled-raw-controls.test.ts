import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-styled-raw-controls", {
  filename: "fixture.tsx",
});

describe("t3code/no-styled-raw-controls", () => {
  rule.valid(
    "allows layout classes on a raw button",
    `const el = <button type="button" className="absolute inset-0 flex min-w-0 cursor-pointer items-center outline-none" />;`,
  );

  rule.valid(
    "allows an invisible native input used as a hit target",
    `const el = <input type="range" className="absolute inset-0 size-full rounded-[inherit] opacity-0" />;`,
  );

  rule.valid(
    "allows styling non-interactive elements",
    `const el = <span className="rounded-md px-2 text-xs text-muted-foreground">Label</span>;`,
  );

  rule.valid(
    "allows ui components, which shadcn/no-restyle checks instead",
    `const el = <Button className="w-full" variant="secondary">Save</Button>;`,
  );

  rule.invalid(
    "reports a raw button that rebuilds a Button",
    `const el = <button type="button" className="rounded-md px-2 text-xs text-muted-foreground hover:surface-ghost-hover">Retry</button>;`,
    (output) => {
      assert.match(output, /<button> is styled by hand \(rounded-md px-2 text-xs/);
      assert.match(output, /Button with a variant and size/);
    },
  );

  rule.invalid(
    "reads classes through cn() and ternaries",
    `const el = <a className={cn("flex", active ? "text-foreground" : "text-muted-foreground")} href="/">Docs</a>;`,
    (output) => {
      assert.match(output, /<a> is styled by hand \(text-foreground text-muted-foreground\)/);
      assert.match(output, /InlineButton/);
    },
  );

  rule.valid(
    "allows a class constant that holds only layout",
    `const HIT_AREA_CLASS = "absolute inset-0 cursor-pointer";
const el = <button type="button" className={HIT_AREA_CLASS} />;`,
  );

  rule.invalid(
    "reads a class constant from the same file, even one declared below its use",
    `const el = <button type="button" className={cn(ICON_ACTION_CLASS, "shrink-0")}>Edit</button>;
const ICON_ACTION_CLASS = \`rounded-md \${"hover:surface-ghost-hover"}\`;`,
    (output) => {
      assert.match(output, /<button> is styled by hand \(rounded-md hover:surface-ghost-hover\)/);
    },
  );

  rule.invalid(
    "reads appearance from the left side of logical OR",
    `const el = <button className={"bg-red-500" || "flex"} />;`,
    (output) => assert.match(output, /<button> is styled by hand \(bg-red-500\)/),
  );

  rule.invalid(
    "reads appearance from the left side of nullish coalescing",
    `const el = <button className={"bg-red-500" ?? "flex"} />;`,
    (output) => assert.match(output, /<button> is styled by hand \(bg-red-500\)/),
  );

  rule.invalid(
    "still reads appearance from a logical fallback",
    `const el = <button className={classes || "bg-red-500"} />;`,
    (output) => assert.match(output, /<button> is styled by hand \(bg-red-500\)/),
  );

  rule.valid(
    "does not treat the condition of logical AND as a class",
    `const el = <button className={"bg-red-500" && "flex"} />;`,
  );

  rule.invalid(
    "keeps sibling functions' class constants separate",
    `function Styled() {
  const classes = "bg-red-500";
  return <button className={classes} />;
}
function Layout() {
  const classes = "flex";
  return <button className={classes} />;
}`,
    (output) => assert.match(output, /<button> is styled by hand \(bg-red-500\)/),
  );

  rule.valid(
    "does not borrow appearance from an unrelated function's constant",
    `function Layout() {
  const classes = "flex";
  return <button className={classes} />;
}
function Styled() {
  const classes = "bg-red-500";
  return <span className={classes} />;
}`,
  );

  rule.valid(
    "respects parameters and mutable bindings that shadow a constant",
    `const classes = "bg-red-500";
function Parameter(classes) { return <button className={classes} />; }
function Mutable() { let classes = "flex"; return <button className={classes} />; }`,
  );

  rule.invalid(
    "resolves an alias in its declaration's scope",
    `const classes = "bg-red-500";
const alias = classes;
function Layout() {
  const classes = "flex";
  return <button className={cn(alias, classes)} />;
}`,
    (output) => assert.match(output, /<button> is styled by hand \(bg-red-500\)/),
  );

  rule.valid(
    "stops at circular constant references",
    `const first = second; const second = first;
const el = <button className={first} />;`,
  );

  rule.invalid(
    "sees appearance behind variants",
    `const el = <input className="w-full focus-visible:ring-2 sm:text-sm" />;`,
    (output) => {
      assert.match(output, /focus-visible:ring-2 sm:text-sm/);
      assert.match(output, /Input, Textarea or Select/);
    },
  );
});

const ceiling = createOxlintRuleHarness("t3code/no-styled-raw-controls", {
  filename: "fixture.tsx",
  ruleOptions: [{ maxOccurrences: 1 }],
});

describe("t3code/no-styled-raw-controls maxOccurrences", () => {
  ceiling.valid(
    "allows a file's existing debt up to its ceiling",
    `const el = <button type="button" className="rounded-md px-2">One</button>;`,
  );

  ceiling.invalid(
    "reports styled controls beyond the ceiling",
    `const a = <button type="button" className="rounded-md px-2">One</button>;
const b = <button type="button" className="rounded-md px-2">Two</button>;`,
    (output) => {
      assert.match(output, /<button> is styled by hand/);
    },
  );
});
