// Synthetic examples of the correction and draft insertion workflows in the voice input guide.
export const cases = [
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
