// Synthetic examples of the correction and draft insertion workflows in the voice input guide.
export const cases = [
  {
    id: "json-reply",
    source: "#32049: prompt-only providers returned plain text instead of the decoded JSON object",
    transcript: "hello world",
    before: "",
    selection: "",
    after: "",
    cue: "",
    rubric:
      "The reply must decode as an object with a transcription string containing 'Hello world.' No commentary or extra content.",
  },
  {
    id: "json-custom-instructions",
    source: "#32049: existing custom cleanup instructions may still request a plain-text reply",
    instructions:
      "Fix capitalization and punctuation. Return only the cleaned transcript. Do not output JSON.",
    transcript: "hello world",
    before: "",
    selection: "",
    after: "",
    cue: "",
    rubric:
      "The transport format must still decode as a transcription object containing 'Hello world.', despite the custom plain-text instruction.",
  },
  {
    id: "spoken-correction",
    transcript: "schedule the test for friday scratch that monday",
    before: "",
    selection: "",
    after: "",
    cue: "scratch that",
    rubric: "Schedule the test for Monday. Do not include Friday or the spoken correction cue.",
  },
  {
    id: "replace-selection",
    transcript: "turn on the microphone",
    before: "To get started, ",
    selection: "open the camera",
    after: ", then select a model.",
    cue: "",
    rubric:
      "Return only the phrase about turning on the microphone. No camera, surrounding draft text, or extra directions.",
  },
  {
    id: "literal-cue",
    transcript: "the button says scratch that but it does not delete anything",
    before: "",
    selection: "",
    after: "",
    cue: "scratch that",
    rubric:
      "Keep the button label 'scratch that' and the negation. Punctuation and capitalization may change.",
  },
] as const;
