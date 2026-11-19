// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/companion/src/executor/policy.ts),
// Apache-2.0, Copyright 2026 Jay Leaton. Modified for Ada.
import type { ComputerAction, ComputerDecision } from "@t3tools/contracts";
import { COMPUTER_CONTROL_KINDS } from "@t3tools/contracts";

/**
 * What a computer action needs before the helper may do it. The server is the authority: the helper asks before
 * every action and acts only on a grant. Pure: no I/O, no clock.
 *
 * Only a step these rules show is safe runs without a tap. Labels come from the screen, so no model's
 * reading of it ever clears a click.
 */

const MAX_LABEL_BYTES = 400;
const MAX_TEXT_BYTES = 4_000;

const SCROLL_DIRECTIONS: ReadonlyArray<string> = ["up", "down", "top", "bottom"];
/** Keys that move or reveal, never submit: the address bar (⌘L) and a new tab (⌘T) included. */
const PASSIVE_KEYS: ReadonlyArray<string> = [
  "space",
  "escape",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "cmd+l",
  "cmd+t",
];
const MAX_URL_BYTES = 4_000;

const auto = (): ComputerDecision => ({ verdict: "auto", why: "" });
const refused = (why: string): ComputerDecision => ({ verdict: "refused", why });

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * A fixed control: the simple ones run without asking, locking the screen asks first, anything else is
 * refused.
 */
export function control(kind: string): ComputerDecision {
  if (!(COMPUTER_CONTROL_KINDS as ReadonlyArray<string>).includes(kind))
    return refused(
      "not one of the fixed controls (open_app, quit_app, volume, media, dark_mode, lock_screen)",
    );
  return kind === "lock_screen" ? { verdict: "tap", why: "locking the screen" } : auto();
}

/** The rule for one on-screen step. */
export function screen(action: ComputerAction): ComputerDecision {
  const label = action.label ?? "";
  if (
    utf8Bytes(label) > MAX_LABEL_BYTES ||
    utf8Bytes(action.name ?? "") > MAX_LABEL_BYTES ||
    utf8Bytes(action.fieldLabel ?? "") > MAX_LABEL_BYTES
  )
    return refused("a label longer than any control's");

  switch (action.kind) {
    case "scroll":
      return SCROLL_DIRECTIONS.includes(action.direction ?? "")
        ? auto()
        : refused("an unknown scroll direction");
    case "surface":
      if (action.what !== "tab" && action.what !== "app")
        return refused("a surface that is neither a tab nor an app");
      if (!action.name) return refused("a surface with no name");
      // Bringing a named app or tab forward changes nothing in it.
      return auto();
    case "pointer":
      // The real pointer and keyboard for a step the background could not take: always the person's to allow.
      return {
        verdict: "tap",
        why: action.why
          ? `it needs your mouse for a moment: ${action.why}`
          : "it needs your mouse for a moment",
      };
    case "press":
      if (PASSIVE_KEYS.includes(action.key ?? "")) return auto();
      if (action.key === "cmd+w")
        return { verdict: "tap", why: "closing a tab or window can lose what is in it" };
      if (action.key !== "enter")
        return refused("a key other than Enter, Tab, Escape, Space, an arrow, ⌘L, ⌘T or ⌘W");
      if (action.fieldRole && searchField(action.fieldRole, action.fieldLabel ?? "")) return auto();
      return { verdict: "tap", why: "pressing Enter could send or submit what was typed" };
    case "type": {
      const text = action.text ?? "";
      if (!text) return refused("typing with no text");
      if (utf8Bytes(text) > MAX_TEXT_BYTES) return refused("more text than one step may type");
      if (/[\r\n]/.test(text))
        return { verdict: "tap", why: "the text has a line break, which can send it" };
      if (searchField(action.role ?? "", label)) return auto();
      return { verdict: "tap", why: "typing into a field that is not a search or address box" };
    }
    case "open_url": {
      const url = action.url ?? "";
      if (utf8Bytes(url) > MAX_URL_BYTES) return refused("an address longer than a page's");
      return /^https?:\/\/[^\s/]+/i.test(url) && URL.canParse(url)
        ? auto()
        : refused("only a web address (http or https) is opened in the browser");
    }
    case "click": {
      const why = consequential(label);
      if (why) return { verdict: "tap", why };
      // A role is the page's own claim: a "tab" or "text box" on a web page can be any control.
      return {
        verdict: "tap",
        why: "whether it could send, buy or delete something cannot be told from its label",
      };
    }
    default:
      return refused(
        "not a step computer use takes (click, type, press, scroll, surface, open_url, pointer)",
      );
  }
}

const SEARCH_WORDS: ReadonlyArray<string> = [
  "search",
  "find",
  "filter",
  "address",
  "url",
  "go to",
  "buscar",
  "búsqueda",
  "rechercher",
  "recherche",
  "suchen",
  "suche",
  "cerca",
  "pesquisar",
  "zoeken",
  "検索",
  "搜索",
];

/** A search, find, filter or address box: typing there and pressing Enter runs a search or opens a page. */
function searchField(role: string, label: string): boolean {
  if (role !== "textbox") return false;
  const lowered = lower(label);
  return SEARCH_WORDS.some((word) => lowered.includes(word));
}

interface Entry {
  readonly why: string;
  readonly words: ReadonlyArray<string>;
}

const LEXICON: ReadonlyArray<Entry> = [
  {
    why: "its label reads as sending or posting",
    words: [
      "send",
      "reply",
      "post",
      "publish",
      "share",
      "tweet",
      "comment",
      "forward",
      "enviar",
      "responder",
      "publicar",
      "compartir",
      "envoyer",
      "répondre",
      "publier",
      "partager",
      "senden",
      "antworten",
      "veröffentlichen",
      "teilen",
      "inviare",
      "rispondi",
      "pubblica",
      "condividi",
      "verzenden",
      "送信",
      "发送",
      "发布",
    ],
  },
  {
    why: "its label reads as buying or paying",
    words: [
      "buy",
      "purchase",
      "pay",
      "checkout",
      "order",
      "subscribe",
      "donate",
      "transfer",
      "book",
      "comprar",
      "pagar",
      "suscribirse",
      "acheter",
      "payer",
      "commander",
      "kaufen",
      "bezahlen",
      "bestellen",
      "abonnieren",
      "acquista",
      "paga",
      "ordina",
      "kopen",
      "betalen",
      "購入",
      "购买",
      "支付",
    ],
  },
  {
    why: "its label reads as deleting",
    words: [
      "delete",
      "remove",
      "erase",
      "discard",
      "trash",
      "archive",
      "uninstall",
      "wipe",
      "eliminar",
      "borrar",
      "supprimer",
      "effacer",
      "löschen",
      "entfernen",
      "elimina",
      "cancella",
      "verwijderen",
      "excluir",
      "削除",
      "删除",
    ],
  },
  {
    why: "its label reads as submitting or confirming",
    words: [
      "submit",
      "confirm",
      "approve",
      "merge",
      "sign",
      "accept",
      "agree",
      "authorize",
      "authorise",
      "enviar",
      "confirmar",
      "aceptar",
      "valider",
      "confirmer",
      "accepter",
      "bestätigen",
      "absenden",
      "akzeptieren",
      "conferma",
      "accetta",
      "bevestigen",
      "確認",
      "确认",
      "提交",
    ],
  },
];

const PHRASES: ReadonlyArray<{ readonly text: string; readonly why: string }> = [
  { text: "check out", why: "its label reads as buying or paying" },
  { text: "place order", why: "its label reads as buying or paying" },
  { text: "add to cart", why: "its label reads as buying or paying" },
  { text: "empty trash", why: "its label reads as deleting" },
  { text: "move to trash", why: "its label reads as deleting" },
];

// ASCII separators only, as the box tokenizes: a multi-byte one would split UTF-8 words.
const SEPARATORS = /[ \t\r\n.,;:!?()[\]{}"'`/\\|\-_+*&#@<>=~^%$]+/;

/** Why a control's label needs a tap, or null. Whole words, ASCII case folded, several languages. */
function consequential(label: string): string | null {
  const lowered = lower(label);
  for (const phrase of PHRASES) if (lowered.includes(phrase.text)) return phrase.why;
  for (const word of lowered.split(SEPARATORS)) {
    if (!word) continue;
    for (const entry of LEXICON) if (entry.words.includes(word)) return entry.why;
  }
  return null;
}

/** ASCII lower case only, as the box folds: other characters are kept, so UTF-8 words still match. */
function lower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}
