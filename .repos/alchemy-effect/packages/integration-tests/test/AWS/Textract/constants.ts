/**
 * Deterministic checked-in test input for the Textract bindings.
 *
 * `HELLO_PNG_BASE64` is a 396x132 grayscale PNG (345 bytes) rendering the
 * word "HELLO" in a 5x7 pixel font scaled 12x, black on white. Generated
 * once by a scripted PNG encoder (IHDR/IDAT/IEND + zlib deflate) and
 * checked in as a constant — crisp enough for Textract OCR.
 */
export const HELLO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAYwAAACECAAAAACmdkNPAAABIElEQVR42u3dMQ6AIAxA0d7/0riymNQUS4f3Z9KIbyNEY2lM4RXAEAwYggFDMGAIBgzBgCEYggFDMGAIBgzBgCEYMHQVI7ZSg17WR6HK85za19eZmb3AgAEDBgwYMGDAgAEDBgwYMGDA6MeY8BJvzcmshwEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDxhyMU5fPKpe9YMCAAQMGDBgwYMCAAQMGDBgwYDgodFAIAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGP0fpp8wZ/lLAAwYMGDAgAEDBgwYMGDAgAEDxm8Y6g8GDMGAIRgwBAOGYMAQDBiCIRgwBAOGYMAQDBiCAUMtPUOmhl+L5IksAAAAAElFTkSuQmCC";

/** The text rendered inside {@link HELLO_PNG_BASE64}. */
export const HELLO_PNG_TEXT = "HELLO";
