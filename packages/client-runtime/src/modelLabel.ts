const VENDOR_PREFIX = /^[^:()]+:\s+(?=\S)/;
const PARENTHETICAL = /\s*\([^()]*\)/g;

const VARIANT_PHRASES: ReadonlyArray<ReadonlyArray<string>> = [
  ["custom", "tools"],
  ...[
    "free",
    "preview",
    "exp",
    "experimental",
    "instruct",
    "chat",
    "base",
    "turbo",
    "spot",
    "latest",
    "new",
    "thinking",
    "reasoning",
    "non-reasoning",
    "distilled",
    "fp8",
    "fp16",
    "bf16",
    "int4",
    "int8",
    "vl",
    "vision",
  ].map((word) => [word]),
];

const SEPARATOR = /^[^\p{L}\p{N}]+$/u;
const STAMP = /^\d{4,}(?:-\d{2}){0,2}$/;
const SIZE_PART = /^(?:\d+x)?a?\d+(?:\.\d+)?[bkmte]$/i;
const VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i;

const isSize = (token: string) => token.split("-").every((part) => SIZE_PART.test(part));

function trailingVariantLength(tokens: ReadonlyArray<string>): number {
  const last = tokens.at(-1)!;
  if (STAMP.test(last) || SEPARATOR.test(last)) return 1;
  const phrase = VARIANT_PHRASES.find(
    (words) =>
      words.length < tokens.length &&
      words.every(
        (word, index) => tokens[tokens.length - words.length + index]!.toLowerCase() === word,
      ),
  );
  return phrase?.length ?? 0;
}

export function composerModelLabel(displayName: string): string {
  let name = displayName.trim().replace(VENDOR_PREFIX, "");
  for (let previous = ""; previous !== name;) {
    previous = name;
    name = name.replace(PARENTHETICAL, "");
  }
  const tokens = name.split(/\s+/).filter(Boolean);
  let size: string | undefined;
  while (tokens.length > 1) {
    const variantLength = trailingVariantLength(tokens);
    if (variantLength > 0) {
      tokens.splice(-variantLength);
    } else if (isSize(tokens.at(-1)!)) {
      size = tokens.pop()!.split("-")[0];
    } else {
      break;
    }
  }
  const distinguished = tokens.slice(1).some((token) => !VERSION.test(token) && !isSize(token));
  if (size && !distinguished) tokens.push(size);
  return tokens.join(" ") || displayName;
}
