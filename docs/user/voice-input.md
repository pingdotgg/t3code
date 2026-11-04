# Voice input

Dictate into the composer instead of typing. The transcript lands in your draft
for review, and only sending the message sends anything to an agent. Dictation
also works in citation comments, diff and file annotations, and pull request
comments, replies, and review summaries.

On iPhone and Android, voice input transcribes on the device. See
[Voice input on mobile](./composer.md#voice-input-on-mobile).

## Choose where audio goes

On web and desktop, transcription runs on one of your T3 Code environments.
Nothing is sent until you choose one: open **Settings → Voice** and set
**Send microphone audio to** the environment that should transcribe for you.
Microphone audio recorded on this device is sent to that environment over your
authenticated connection, transcribed there, and discarded. The choice is saved
on this device only, so every computer and browser you use asks for it once.
Set it back to **Off** at any time; a recording in progress is discarded.

If the chosen environment goes offline, voice input waits for it. T3 Code never
substitutes another environment.

## Set up a model

The first time you dictate, T3 Code offers to download the recommended English
model to the chosen environment. **Settings → Voice → Transcription models**
lists every model with its languages and size, lets you download, switch, or
delete them, and chooses whether the environment transcribes on its GPU or CPU
and how long it keeps the model in memory after use. With hardware set to
**Auto**, a recording that fails on the GPU is retried once on that same
environment's CPU; a GPU you picked yourself reports the error instead. Nothing
is ever retried on another environment. Models marked **Live preview** show
text while you speak; others transcribe when you stop.

## Dictate

Press the microphone in the composer, or `mod+shift+d` (`mod` is Command on
macOS and Ctrl elsewhere). Press again, or the check mark, to finish; `Esc`
discards the recording and leaves your draft unchanged. Recordings last up to
five minutes. Text is inserted at the cursor or replaces the selection you had
when recording started, and the editor is read-only while dictation runs.

Pressing Send while dictating finishes the recording and sends the draft once
the transcript has been inserted. Cancelling also cancels that queued send. In
the other editors, Save, Comment, Reply, or Submit review works the same way,
and the shortcut targets the editor that has focus, or the composer when none
does.

**Dictation shortcut** in Voice settings picks how the keybinding behaves:
**Auto** tap-toggles or records while held, **Hold** records only while the keys
are down, and **Toggle** always needs a second press. Change the chord itself in
[Keybindings settings](./keybindings.md).

## Improve recognition

- **Language** picks what you speak. **Auto** lets a multilingual model detect
  it. Models that translate offer **Translate to English**.
- **Dictionary** holds names and terms the model should get right. Add an alias
  under a term when transcription keeps producing a particular misspelling.
  Your dictionary is saved on this device. The name of the project you dictate
  in is sent along as a hint.
- **Project dictionary** is vocabulary saved with a project on its environment,
  so everyone who dictates in that project gets the same spellings. Pick the
  project at the top of Settings to edit it; with an environment selected, the
  entries apply to every project there. Project spellings win when they overlap
  your personal dictionary. Each recording carries up to 100 entries from the
  two combined.
- **Remove filler words** drops hesitation sounds from finished transcripts.

Language and these preferences travel with each recording to the chosen
environment; nothing else about the project is sent.

## Clean up transcripts with a provider

**Transcript cleanup** is a separate choice and is off by default. When on, the
finished transcript and up to 1,024 characters each from before, inside, and
after your selection are sent to the
text generation provider configured on the draft's environment, which fixes
punctuation, numbers, and spoken corrections such as "make it 42, sorry, 24".
Depending on the provider, that can involve an external service. Audio is never
sent to it. Use the built-in instructions or write your own, press **Skip**
while cleanup runs to insert the raw transcript, and if cleanup fails the raw
transcript is inserted.

Cleanup uses the environment's text generation model unless you pick a
**Cleanup model** for that environment, for example a cheaper or faster one.

If cleanup misses the way you correct yourself, set a **Correction cue**: the
word or phrase you say to flag a correction, such as "scratch that". Cleanup
applies the correction only where the context shows one and drops the cue, and
the model hears the cue as a dictionary hint.

## Test and troubleshoot

**Settings → Voice → Test** has two checks that are deliberately different.
**Test microphone** records up to ten seconds and plays it back in your browser;
the audio stays on this device and is never transcribed, so silent playback
points at the microphone. **Test model** dictates into a scratch box through the
same environment, language, and dictionary as the composer, but skips transcript
cleanup even when it is on, so you see what the model heard. Browser recording
needs HTTPS or localhost and microphone permission; for a remote server over
plain HTTP, use the desktop app. If the selected microphone is missing, choose
another or the system default.
