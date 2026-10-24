/** Latin-1 entity names in code point order from U+00A0; storage XHTML writes these characters as entities. */
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

/** `nbsp` decodes to a plain space: every caller compares or displays text, never re-encodes it. */
const ENTITIES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    LATIN1.split(" ").map((name, index) => [name, String.fromCodePoint(0xa0 + index)]),
  ),
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201A",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bdquo: "\u201E",
  bull: "\u2022",
  hellip: "\u2026",
  euro: "\u20AC",
  trade: "\u2122",
};

/** Decode named HTML entities (the XML five, Latin-1, common punctuation) and numeric `&#39;` / `&#x27;`. */
export function decodeEntities(text: string): string {
  return text.replaceAll(
    /&(?:([A-Za-z][A-Za-z0-9]{1,7})|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g,
    (match, name?: string, dec?: string, hex?: string) => {
      if (name !== undefined) {
        return ENTITIES[name] ?? match;
      }
      const code = dec === undefined ? Number.parseInt(hex ?? "", 16) : Number.parseInt(dec, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}
