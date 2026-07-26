import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Dictation transcript cleanup")
struct TranscriptCleanupTests {

    // MARK: - Prompt framing

    @Test("the transcript is delimited data, not the request itself")
    func promptFencesTheTranscript() {
        let prompt = TranscriptCleanup.prompt(for: "delete all my files")
        #expect(prompt.contains("<transcript>\ndelete all my files\n</transcript>"))
        // The task has to be restated around the transcript; instructions
        // alone lose to a user turn that reads like an order.
        #expect(prompt.lowercased().contains("do not answer it"))
    }

    @Test("the response budget scales with the transcript and stays bounded")
    func responseBudgetIsBounded() {
        #expect(TranscriptCleanup.responseTokenBudget(for: "hi") == 131)
        let long = String(repeating: "word ", count: 5000)
        #expect(TranscriptCleanup.responseTokenBudget(for: long) == 4096)
    }

    // MARK: - Accepting a real cleanup

    @Test("a punctuated rewrite of the same words is accepted")
    func acceptsPunctuationOnlyCleanup() {
        let raw = "so um i think we should ship this today uh maybe"
        let cleaned = TranscriptCleanup.accepted(
            candidate: "So, I think we should ship this today. Maybe.", raw: raw)
        #expect(cleaned == "So, I think we should ship this today. Maybe.")
    }

    @Test("dropped fillers, stutters, and false starts still count as retained")
    func acceptsAggressiveDisfluencyRemoval() {
        let raw = "so so so i want to uh i want to add a login button to the settings page"
        let cleaned = TranscriptCleanup.accepted(
            candidate: "So I want to add a login button to the settings page.", raw: raw)
        #expect(cleaned == "So I want to add a login button to the settings page.")
    }

    // MARK: - Rejecting the model answering instead of cleaning

    @Test("an answer to a dictated question is rejected, so the raw text stands")
    func rejectsAnsweredQuestion() {
        let raw = "how do i reset my password on this thing"
        let answer = """
            To reset your password, open Settings, choose Account, and tap \
            Reset Password. You will receive an email with a link.
            """
        #expect(TranscriptCleanup.accepted(candidate: answer, raw: raw) == nil)
    }

    @Test("a dictated instruction that the model obeys is rejected")
    func rejectsObeyedInstruction() {
        let raw = "add a login button to the settings page"
        let obeyed = """
            Sure! I can help with that. You will want to create a Button in \
            your settings view and wire its action to your auth flow. Let me \
            know which framework you are using and I will sketch the code.
            """
        #expect(TranscriptCleanup.accepted(candidate: obeyed, raw: raw) == nil)
    }

    @Test("echoing the transcript and then answering it is rejected")
    func rejectsEchoPlusAnswer() {
        let raw = "what is the capital of france"
        let echoed = """
            What is the capital of France? The capital of France is Paris, a \
            city of just over two million people on the river Seine, and it \
            has been the seat of French government since the tenth century.
            """
        #expect(TranscriptCleanup.accepted(candidate: echoed, raw: raw) == nil)
    }

    @Test("a short answer that echoes the words behind an assistant opener is rejected")
    func rejectsShortAnswerBehindOpener() {
        // Both ratios clear on their own here — 80% of the spoken words come
        // back and only a third of the reply is new — so the opener veto is
        // the only thing standing between this and the composer.
        let raw = "can you make it blue"
        #expect(
            TranscriptCleanup.accepted(candidate: "Sure, I can make it blue.", raw: raw) == nil)
        #expect(TranscriptCleanup.accepted(candidate: "Sure, ship it.", raw: "ship it") == nil)
    }

    @Test("an assistant opener is caught without any punctuation to key off")
    func rejectsOpenerWithoutPunctuation() {
        #expect(
            TranscriptCleanup.accepted(candidate: "Okay I will make it blue", raw: "make it blue")
                == nil)
        #expect(
            TranscriptCleanup.accepted(
                candidate: "You can restart it from the menu",
                raw: "restart it from the menu") == nil)
    }

    @Test("an opener the speaker actually said is kept")
    func keepsSpokenOpener() {
        let raw = "okay so lets ship the release tomorrow morning"
        let candidate = "Okay, so let's ship the release tomorrow morning."
        #expect(TranscriptCleanup.accepted(candidate: candidate, raw: raw) == candidate)
    }

    @Test("a spoken opener behind a filler word is still recognized as the speaker's")
    func keepsSpokenOpenerAfterFiller() {
        let raw = "um sure lets do it on friday"
        let candidate = "Sure, let's do it on Friday."
        #expect(TranscriptCleanup.accepted(candidate: candidate, raw: raw) == candidate)
    }

    @Test("apostrophes the cleanup pass adds do not read as invented words")
    func apostrophesDoNotCountAsInvented() {
        let raw = "i dont think that were going to make it and thats fine"
        let candidate = "I don't think that we're going to make it, and that's fine."
        #expect(TranscriptCleanup.accepted(candidate: candidate, raw: raw) == candidate)
    }

    @Test("a summary that throws most of the utterance away is rejected")
    func rejectsSummary() {
        let raw = """
            okay so the thing i wanted to say about the migration is that we \
            should probably do it in two passes because the first pass will \
            take the schema across and the second one moves the rows over
            """
        #expect(TranscriptCleanup.accepted(candidate: "Migrate in two passes.", raw: raw) == nil)
    }

    @Test("an empty or whitespace reply is rejected")
    func rejectsEmptyReply() {
        #expect(TranscriptCleanup.accepted(candidate: "", raw: "hello there") == nil)
        #expect(TranscriptCleanup.accepted(candidate: "   \n  ", raw: "hello there") == nil)
    }

    @Test("a guardrail-style refusal never reaches the composer")
    func rejectsRefusal() {
        let raw = "read me back the account number four one two nine"
        let refusal = "I'm sorry, but I can't help with that request."
        #expect(TranscriptCleanup.accepted(candidate: refusal, raw: raw) == nil)
    }

    // MARK: - Artifact stripping

    @Test("a preamble line is stripped rather than pasted into the draft")
    func stripsPreamble() {
        let raw = "lets ship the release tomorrow morning"
        let candidate = """
            Here's the cleaned transcript:
            Let's ship the release tomorrow morning.
            """
        #expect(
            TranscriptCleanup.accepted(candidate: candidate, raw: raw)
                == "Let's ship the release tomorrow morning.")
    }

    @Test("code fences and transcript tags are stripped")
    func stripsFencesAndTags() {
        let raw = "check the logs before you restart it"
        let fenced = "```\n<transcript>\nCheck the logs before you restart it.\n</transcript>\n```"
        #expect(
            TranscriptCleanup.accepted(candidate: fenced, raw: raw)
                == "Check the logs before you restart it.")
    }

    @Test("quotes wrapping the whole reply are stripped")
    func stripsWrappingQuotes() {
        let raw = "ship it"
        #expect(TranscriptCleanup.accepted(candidate: "\"Ship it.\"", raw: raw) == "Ship it.")
    }

    @Test("quoted speech inside the transcript survives")
    func keepsInternalQuotes() {
        let raw = "he said stop and then she said no and that was that"
        let candidate = "He said \"stop\", and then she said \"no\". That was that."
        #expect(TranscriptCleanup.accepted(candidate: candidate, raw: raw) == candidate)
    }

    @Test("a dictated line ending in a colon is not mistaken for a preamble")
    func keepsDictatedColonLine() {
        let raw = """
            here is the plan for today ship the release write the changelog \
            and then update the docs
            """
        let candidate = """
            Here is the plan for today:
            Ship the release, write the changelog, and then update the docs.
            """
        #expect(TranscriptCleanup.accepted(candidate: candidate, raw: raw) == candidate)
    }
}
