// Writes the component list the server validates and describes OpenUI programs with. It reads the
// browser bundle that draws them, so the two cannot disagree. Run after upgrading OpenUI.
// @effect-diagnostics nodeBuiltinImport:off - A standalone generator.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";

// A rendered page cannot send anything back to the thread, so nothing that takes input or acts.
const UNSUPPORTED = new Set(
  (
    "Form FormControl Label Input TextArea Select SelectItem DatePicker Slider CheckBoxGroup " +
    "CheckBoxItem RadioGroup RadioItem SwitchGroup SwitchItem Chips ChipItem OptionCards " +
    "OptionCard Button Buttons IconButton FollowUpBlock FollowUpItem EditableTable"
  ).split(" "),
);

interface BundleSpec {
  readonly root: string;
  readonly components: Record<string, { signature: string; description?: string }>;
  readonly componentGroups: ReadonlyArray<{ name: string; components: ReadonlyArray<string> }>;
  readonly schema: { readonly $defs: Record<string, unknown> };
}

const readBundleSpec = (): BundleSpec => {
  const bundle = NodeModule.createRequire(import.meta.url).resolve("@openuidev/browser-bundle");
  const noop = () => {};
  const element = () => ({
    style: { setProperty: noop },
    setAttribute: noop,
    appendChild: noop,
    removeChild: noop,
    addEventListener: noop,
    getElementsByTagName: () => [],
    childNodes: [],
  });
  // Only enough of a browser for the bundle to define its components; nothing is rendered.
  const window: Record<string, unknown> = {
    document: {
      createElement: element,
      createElementNS: element,
      createTextNode: element,
      head: element(),
      body: element(),
      documentElement: element(),
      addEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      getElementsByTagName: () => [],
    },
    navigator: { userAgent: "node" },
    location: { href: "about:blank", protocol: "about:" },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    addEventListener: noop,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    TextEncoder,
    TextDecoder,
  };
  window.window = window;
  window.self = window;
  const context = NodeVM.createContext(window);
  NodeVM.runInContext(NodeFS.readFileSync(bundle, "utf8"), context);
  const spec: unknown = NodeVM.runInContext(
    "JSON.stringify(__OpenUI.openuiChatLibrary.toSpec())",
    context,
  );
  return JSON.parse(String(spec)) as BundleSpec;
};

const withoutUnsupported = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(withoutUnsupported);
  if (typeof schema !== "object" || schema === null) return schema;
  const ref = (schema as { $ref?: unknown }).$ref;
  // The property stays, because the parser assigns positional arguments by property order.
  if (typeof ref === "string" && UNSUPPORTED.has(ref.slice("#/$defs/".length))) return {};
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "anyOf" && Array.isArray(value)
        ? value.map(withoutUnsupported).filter((option) => Object.keys(option as object).length > 0)
        : withoutUnsupported(value),
    ]),
  );
};

// The renderer asks Google for the icon of every cited site, so Card does not offer sources.
const withoutSources = (name: string, definition: unknown) => {
  if (name !== "Card") return definition;
  const card = definition as { properties: Record<string, unknown> };
  const { sources: _, ...properties } = card.properties;
  return { ...card, properties };
};

const describeComponent = (component: { signature: string; description?: string }) => {
  const signature = [...UNSUPPORTED]
    .reduce(
      (text, name) => text.replace(new RegExp(`\\b${name} \\| | \\| ${name}\\b`, "g"), ""),
      component.signature,
    )
    // Each of these is followed only by arguments that may also be left out.
    .replace(/, (?:actionLabel|action|visible)\?: [^)]*(?=\))/, "")
    .replace(/, button\?: Button\b/, "")
    .replace(/ \| "action"/, "");
  const description = (component.description ?? "")
    .replaceAll("price/button", "price")
    .split(/(?<=\.)\s+|;\s+/)
    .filter((sentence) => !/\baction\b|clickable|\$visible/i.test(sentence))
    .join("; ")
    .replace(/\.;/g, ".");
  return description === "" ? signature : `${signature} — ${description}`;
};

export const buildOpenUiSpec = () => {
  const spec = readBundleSpec();
  const lines = spec.componentGroups
    .flatMap((group) => group.components)
    .filter((name) => !UNSUPPORTED.has(name))
    .map((name) => describeComponent(spec.components[name]!));
  const card = describeComponent(spec.components[spec.root]!)
    .replace(/, sources\?: \{[^}]*\}\[\]/, "")
    .replace(/ Optional sources .*$/, "");
  const block = /children: \(([^()]+)\)\[\]/.exec(card)![1]!;
  // The same long list of children recurs in every container.
  const shorten = (line: string) =>
    line.replace(/\(([A-Za-z]+(?: \| [A-Za-z]+){14,})\)\[\]/g, "Block[]");
  return {
    root: spec.root,
    signatures: [`Block = ${block}`, shorten(card), ...lines.map(shorten)].join("\n"),
    schema: {
      ...(withoutUnsupported({ ...spec.schema, $defs: undefined }) as object),
      $defs: Object.fromEntries(
        Object.entries(spec.schema.$defs)
          .filter(([name]) => !UNSUPPORTED.has(name))
          .map(([name, definition]) => [
            name,
            withoutSources(name, withoutUnsupported(definition)),
          ]),
      ),
    },
  };
};

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  NodeFS.writeFileSync(
    NodePath.join(import.meta.dirname, "../src/htmlRender/openUiSpec.generated.json"),
    `${JSON.stringify(buildOpenUiSpec(), null, 2)}\n`,
  );
}
