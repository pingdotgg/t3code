/**
 * Positional keyboard layout tables, used to rescue a search typed while a
 * non-Latin layout was active: the characters that reached the query are mapped
 * back to the US QWERTY characters the same physical keys would have produced.
 *
 * Mapping only ever runs towards US QWERTY. Latin-script layouts (AZERTY,
 * QWERTZ, Dvorak, Colemak) are deliberately absent, because their output cannot
 * be told apart from intended Latin input and mapping them would corrupt
 * ordinary English queries.
 *
 * TODO: scripts whose input needs a different algorithm stay unsupported here:
 * Korean (hangul syllables must be decomposed into jamo), Japanese kana, CJK IME
 * input, Indic InScript, and Vietnamese Telex/VNI. A layout whose number row is
 * left out below is read through its letter rows alone, so a query holding a
 * character off that row, such as a Kazakh `ә`, has no reading at all.
 */

/** Unshifted US QWERTY output in key order, one character per physical key. */
export const US_KEY_REFERENCE = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";

/** The same for the number row, which only the Thai layouts below map. */
export const US_NUMBER_KEY_REFERENCE = "`1234567890-=";

interface KeyboardLayout {
  readonly id: string;
  readonly unshifted: string;
  readonly shifted?: string;
  /** Aligned to {@link US_NUMBER_KEY_REFERENCE}, not to the letter rows. */
  readonly numbers?: string;
}

/**
 * One character per key of {@link US_KEY_REFERENCE}, transcribed from
 * https://kbdlayout.info, which is the only record of where these characters
 * sit. A `shifted` row appears only where the shift level carries letters of its
 * own: cased scripts reach theirs by lowercasing, and shift levels that produce
 * Latin, punctuation or diacritics need no mapping. A `numbers` row appears only
 * for the Thai layouts. Kazakh, Arabic and Persian carry letters or non-ASCII
 * digits on their number row too, but Kazakh puts one letter's upper and lower
 * case on adjacent unshifted keys, which lowercases into the wrong key, and a
 * non-ASCII digit cannot appear in a Latin name, so mapping those rows would
 * answer today's miss with a wrong match.
 */
export const KEYBOARD_LAYOUTS: ReadonlyArray<KeyboardLayout> = [
  { id: "russian", unshifted: "йцукенгшщзхъфывапролджэячсмитьбю.ё" },
  { id: "ukrainian", unshifted: "йцукенгшщзхїфівапролджєячсмитьбю.ё" },
  { id: "belarusian", unshifted: "йцукенгшўзх'фывапролджэячсмітьбю.ё" },
  { id: "bulgarian-bds", unshifted: ",уеишщксдзц;ьяаожгтнвмчюйъэфхпрлб`" },
  { id: "bulgarian-phonetic", unshifted: "чшертъуиопящасдфгхйкл;'зжцвбнм,./ю" },
  { id: "serbian-cyrillic", unshifted: "љњертзуиопшђасдфгхјклчћѕџцвбнм,.-`" },
  { id: "macedonian", unshifted: "љњертѕуиопшѓасдфгхјклчќзџцвбнм,./`" },
  { id: "kazakh", unshifted: "йцукенгшщзхъфывапролджэячсмитьбю№(" },
  { id: "greek", unshifted: ";ςερτυθιοπ[]ασδφγηξκλ΄'ζχψωβνμ,./`" },
  { id: "hebrew", unshifted: "/'קראטוןםפ][שדגכעיחלךף,זסבהנמצתץ.;" },
  { id: "armenian-eastern", unshifted: "խւէրտեըիոպչջասդֆքհճկլթփզցգվբնմշղծ՝" },
  { id: "armenian-western", unshifted: "խվէրդեըիոբչջաստֆկհճքլթփզցգւպնմշղծ՝" },
  { id: "georgian", unshifted: "ღჯუკენგშწზხცფძვთაპროლდჟჭჩყსმიტქბჰ„" },
  // The lam-alef key stands here as its ligature so the row keeps one character
  // per key; the sequence it really emits is indexed alongside it below.
  { id: "arabic", unshifted: "ضصثقفغعهخحجدشسيبلاتنمكطئءؤرﻻىةوزظذ" },
  { id: "persian", unshifted: "ضصثقفغعهخحجچشسیبلاتنمکگظطزرذدئو./÷" },
  {
    id: "thai-kedmanee",
    unshifted: "ๆไำพะัีรนยบลฟหกดเ้่าสวงผปแอิืทมใฝ_",
    numbers: "_ๅ/-ภถุึคตจขช",
    shifted: '๐"ฎฑธํ๊ณฯญฐ,ฤฆฏโฌ็๋ษศซ.()ฉฮฺ์?ฒฬฦ%',
  },
  {
    id: "thai-pattachote",
    unshifted: "็ตยอร่ดมวแใฌ้ทงกัีานเไขบปลหิคสะจพ_",
    numbers: "_=๒๓๔๕ู๗๘๙๐๑๖",
    shifted: "๊ฤๆญษึฝซถฒฯฦ๋ธำณ์ืผชโฆฑฎฏฐภัศฮฟฉฬ฿",
  },
];

/**
 * Whether a key of this layout emits characters that are each a key of their own
 * here. The Arabic lam-alef key is one: it produces exactly what `ل` then `ا`
 * produce, so such a sequence has two honest readings and both have to be
 * offered. A decomposed `ё` is not ambiguous, because the combining mark it
 * ends with sits on no key.
 */
function hasAmbiguousMultiCharacterKey(characterMap: ReadonlyMap<string, string>): boolean {
  for (const key of characterMap.keys()) {
    if (key.length > 1 && [...key].every((character) => characterMap.has(character))) {
      return true;
    }
  }
  return false;
}

function buildLayoutIndex(): {
  readonly characterMapsByLayoutId: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly layoutIdsByCharacter: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly ambiguousLayoutIds: ReadonlySet<string>;
} {
  const characterMapsByLayoutId = new Map<string, ReadonlyMap<string, string>>();
  const layoutIdsByCharacter = new Map<string, string[]>();
  const ambiguousLayoutIds = new Set<string>();

  for (const layout of KEYBOARD_LAYOUTS) {
    const characterMap = new Map<string, string>();
    const rows = [
      { row: layout.unshifted, reference: US_KEY_REFERENCE },
      { row: layout.numbers, reference: US_NUMBER_KEY_REFERENCE },
      { row: layout.shifted, reference: US_KEY_REFERENCE },
    ];

    for (const { row, reference } of rows) {
      if (row === undefined) continue;
      for (const [index, character] of [...row].entries()) {
        const usCharacter = reference[index]!;
        // An unshifted level wins when two levels reach the same character, as
        // Thai Pattachote's `ั` does; the unshifted key is the likelier origin.
        if (characterMap.has(character)) continue;
        characterMap.set(character, usCharacter);
        // Index the decomposed spelling too: the Arabic lam-alef key emits its
        // two letters rather than the ligature the table holds, and a query can
        // carry a decomposed `ё` just as easily as a composed one.
        const decomposed = character.normalize("NFKD");
        if (decomposed !== character && !characterMap.has(decomposed)) {
          characterMap.set(decomposed, usCharacter);
        }
      }
    }

    characterMapsByLayoutId.set(layout.id, characterMap);
    if (hasAmbiguousMultiCharacterKey(characterMap)) ambiguousLayoutIds.add(layout.id);
    for (const character of characterMap.keys()) {
      const layoutIds = layoutIdsByCharacter.get(character);
      if (layoutIds) layoutIds.push(layout.id);
      else layoutIdsByCharacter.set(character, [layout.id]);
    }
  }

  return { characterMapsByLayoutId, layoutIdsByCharacter, ambiguousLayoutIds };
}

const { characterMapsByLayoutId, layoutIdsByCharacter, ambiguousLayoutIds } = buildLayoutIndex();

const NO_LAYOUT_VARIANTS: ReadonlyArray<string> = [];

/**
 * The first non-ASCII character of `value`, or `undefined` when it holds none.
 * One scan answers both questions this module asks, and an ASCII query, the
 * common case on a hot path, allocates nothing.
 */
function findNonAsciiCharacter(value: string): string | undefined {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return String.fromCodePoint(value.codePointAt(index)!);
  }
  return undefined;
}

/**
 * Looks a character up directly, then through its NFD base. Greek accented
 * vowels such as `ά` only reach `a` that way. Normalizing before the direct
 * lookup would instead fold Cyrillic `й` into `и` and `ё` into `е`, which sit on
 * entirely different keys.
 */
function lookupCharacter<T>(index: ReadonlyMap<string, T>, character: string): T | undefined {
  const direct = index.get(character);
  if (direct !== undefined) return direct;
  const base = character.normalize("NFD")[0];
  return base === undefined || base === character ? undefined : index.get(base);
}

/** Reads every character as a keystroke of its own. */
function mapCharactersSeparately(
  characters: ReadonlyArray<string>,
  characterMap: ReadonlyMap<string, string>,
): string {
  let mapped = "";

  for (const character of characters) {
    // Characters this layout does not place, such as spaces, pass through.
    mapped += lookupCharacter(characterMap, character) ?? character;
  }

  return mapped;
}

/**
 * Reads a key that emits several characters, such as the Arabic lam-alef key or
 * a decomposed `ё`, as that one key rather than as its first character's key.
 */
function mapCharactersThroughMultiCharacterKeys(
  characters: ReadonlyArray<string>,
  characterMap: ReadonlyMap<string, string>,
): string {
  let mapped = "";

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];
    const pairMatch = next === undefined ? undefined : characterMap.get(character + next);
    if (pairMatch !== undefined) {
      mapped += pairMatch;
      index += 1;
      continue;
    }
    // Characters this layout does not place, such as spaces, pass through.
    mapped += lookupCharacter(characterMap, character) ?? character;
  }

  return mapped;
}

function mapQueryAcrossKeyboardLayouts(query: string): ReadonlyArray<string> {
  const trigger = findNonAsciiCharacter(query);
  if (trigger === undefined) return NO_LAYOUT_VARIANTS;

  const layoutIds = lookupCharacter(layoutIdsByCharacter, trigger.toLowerCase());
  if (layoutIds === undefined) return NO_LAYOUT_VARIANTS;

  const lowercased = query.toLowerCase();
  const characters = [...lowercased];
  const variants = new Set<string>();
  for (const layoutId of layoutIds) {
    const characterMap = characterMapsByLayoutId.get(layoutId)!;
    variants.add(mapCharactersThroughMultiCharacterKeys(characters, characterMap));
    if (ambiguousLayoutIds.has(layoutId)) {
      variants.add(mapCharactersSeparately(characters, characterMap));
    }
  }
  variants.delete(lowercased);

  // A reading that kept a non-ASCII character went through a layout that does
  // not place it, and no Latin name can contain one. Dropping it here spares
  // every caller a tier chain that cannot match, the longer the query the more.
  return [...variants].filter((variant) => findNonAsciiCharacter(variant) === undefined);
}

/**
 * One entry, because the hot path scores one query against many values:
 * `scoreQueryMatch` expands inside itself for every value a query misses
 * directly, so one keystroke over a large file tree reaches here thousands of
 * times with the same string. A caller that alternates between several queries,
 * such as one testing every token of a multi-token query per node, misses on
 * each switch and remaps. Mapping is pure, so answering from the last call is
 * unobservable.
 */
let lastQuery: string | undefined;
let lastVariants: ReadonlyArray<string> = NO_LAYOUT_VARIANTS;

/**
 * Maps `query` back to the US QWERTY characters its keys would have produced, on
 * every layout that places its first non-ASCII character, so Latin-script names
 * still match. The result is lowercased, deduplicated, and excludes both the
 * query itself and any reading that is still not plain ASCII. A layout whose
 * keys overlap contributes both readings, one taking every multi-character key
 * and one taking none, since only the typist knows which keys were pressed.
 * Expect a handful: one reading per layout that places that character, two from
 * the overlapping ones, less whatever dedup and the ASCII filter drop.
 *
 * A query that is already plain ASCII returns nothing: every supported layout is
 * a non-Latin script, so that single test keeps Latin queries off this path.
 */
export function expandQueryAcrossKeyboardLayouts(query: string): ReadonlyArray<string> {
  if (query !== lastQuery) {
    lastVariants = mapQueryAcrossKeyboardLayouts(query);
    lastQuery = query;
  }
  return lastVariants;
}
