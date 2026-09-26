import { describe, expect, it } from "vite-plus/test";
import { acceptVoicePunctuation } from "./VoicePunctuation.ts";

describe("dictation punctuation guard", () => {
  it("accepts questions, sentence boundaries, commas and capitalization", () => {
    expect(
      acceptVoicePunctuation(
        "can you check it please it seems slow why is that",
        "Can you check it, please? It seems slow. Why is that?",
      ),
    ).toBe("Can you check it, please? It seems slow. Why is that?");
  });
  it("rejects answers, omissions, additions, reordered words and changed numbers", () => {
    for (const candidate of [
      "Yes, I can.",
      "Can you check?",
      "Please, can you check it?",
      "Can you please check it?",
      "Can you check it? Here is the result.",
    ]) {
      expect(acceptVoicePunctuation("can you check it", candidate)).toBe("can you check it");
    }
    expect(acceptVoicePunctuation("use version 3.14", "Use version 314.")).toBe("use version 3.14");
    expect(acceptVoicePunctuation("keep foo_bar and a/b", "Keep foo bar and a b.")).toBe(
      "keep foo_bar and a/b",
    );
  });
  it("keeps programming language names intact", () => {
    expect(acceptVoicePunctuation("use C++ and C#", "Use C and C.")).toBe("use C++ and C#");
  });
  it("preserves non-English words and contractions", () => {
    expect(acceptVoicePunctuation("pourquoi ça ne marche pas", "Pourquoi ça ne marche pas ?")).toBe(
      "Pourquoi ça ne marche pas ?",
    );
    expect(acceptVoicePunctuation("isn't it working", "Isn't it working?")).toBe(
      "Isn't it working?",
    );
    expect(acceptVoicePunctuation("don't do that", "Do that.")).toBe("don't do that");
  });
});
