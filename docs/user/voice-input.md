# Voice input

Dictate into the composer instead of typing. The transcript lands in your draft
for review, and only sending the message sends anything to an agent. Dictation
also works in citation comments, diff and file annotations, pull request
comments, replies, and review summaries, and in the desktop app's browser
annotation editor.

On iPhone and Android, voice input transcribes on the device by default. To opt in
to a named environment on that phone, open **Settings → Voice → Transcribe on**. See
[Voice input on mobile](./composer.md#voice-input-on-mobile).

## Choose where audio goes

On web and desktop, you choose where transcription runs.
Nothing is sent until you choose one: open **Settings → Voice** and set
**Transcribe with** to the environment that should transcribe for you.
On a new device, the microphone or dictation shortcut opens that setting from the composer.
Microphone audio recorded on this device is sent to that environment over your
authenticated connection, transcribed there, and discarded. The choice is saved
on this device only, so every computer and browser you use asks for it once.
Set it back to **Off** at any time; a recording in progress is discarded.

If the chosen environment goes offline, voice input waits for it. T3 Code never
substitutes another environment.

For cloud dictation, choose **OpenAI** or **Grok Voice Transcribe** via the environment
you want to use. If it needs a key, enter one and choose **Save and enable**.
You can also choose a [secret provider](secrets.md) instead of **Value** and enter a
reference. Unlock the vault on that environment before dictating. Anyone with
dictation access to the environment can use the key, but only this device opts in.
If a key is already saved, just confirm the provider. After
you stop, the environment forwards your recording and any vocabulary hints to
the selected provider, which bills its API account. No local model download or chat
subscription is needed. Switch back to **This device** on mobile or **Off** on
web and desktop to stop sharing. Removing the key stops that provider for everyone
on the environment.

**OpenRouter** works the same way but has no default model: pick one from its live
speech-to-text catalog when you enable it, or later under **Manage OpenRouter**.
The model choice is yours alone and needs no settings access, so anyone with
dictation access can pick a different model without touching the saved key.
OpenRouter chooses who runs the model. T3 requests zero data retention; your
OpenRouter account can also allow safety retention. If no endpoint qualifies,
dictation fails instead of switching models.
Vocabulary hints are not sent to OpenRouter; dictionary spellings are applied
after transcription. If OpenRouter stops listing your model, dictation stops
until you choose another.

## Set up a model

In **Settings → Voice → Transcription**, download a model and choose **Use model** if it
isn’t already selected. **Test model** lets you try it without sending a message.
If you use the composer microphone before a model is installed, it offers to download one.
The recommendation uses your Voice language, or your system’s preferred languages with **Auto-detect**.

If another app already downloaded one of these models, you don’t need a second copy.
**Download** first looks in Handy’s model folder and the Hugging Face cache on that
environment and uses a copy it finds there instead of downloading. For a copy anywhere
else, on web or desktop, paste the path of the model file or its folder under the model
list and choose **Use existing**. The path is on the environment
that transcribes, not on the device you are using. T3 Code checks that the file is exactly a
model from its list and then uses it in place. Removing the model in T3 Code leaves your file
alone; if the other app deletes it, download or link the model again. Files in another
format, such as Core ML, ONNX, or MLX builds of the same model, can’t be used.

Select the languages you dictate in to compare models that support all of them.
Accuracy shows how often the model got words or characters wrong in each
language; speed is the time to transcribe 30 seconds on a reference GPU. Choose
**All languages** to browse the full catalog. Filtering does not switch your model.

**Advanced** controls GPU or CPU use and when an idle model is unloaded. With hardware set to
**Auto**, a recording that fails on the GPU is retried once on that same
environment's CPU; a GPU you picked yourself reports the error instead. Nothing
is ever retried on another environment. Models marked **Live preview** show
text while you speak. Other models can process long recordings in chunks at pauses
while you record; models with built-in long-form support transcribe when you stop.

## Dictate

Press the microphone in the composer, or `mod+shift+d` (`mod` is Command on
macOS and Ctrl elsewhere). Press again, or the check mark, to finish; `Esc`
discards the recording and leaves your draft unchanged. Recordings last up to
five minutes. Text is inserted at the cursor or replaces the selection you had
when recording started, and the editor is read-only while dictation runs.

Pressing Send while dictating finishes the recording and sends the draft once
the transcript has been inserted. Cancelling also cancels that queued send. In
the other editors, Save, Comment, Reply, Submit review, or Attach works the
same way, and the shortcut targets the editor that has focus, or the composer
when none does. In the desktop browser's annotation editor, the microphone and
the shortcut work while the page has focus; the page you are annotating never
sees the recording, which runs in T3 Code itself.

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
- **Silence filtering** is on by default. Your chosen environment skips non-speech
  audio before transcription. Turn it off to keep those sections. Filtering happens
  after upload: it does not grant permission to send audio or reduce how much is sent.
- **Remove filler words** drops hesitation sounds from finished transcripts.

Language and these preferences travel with each recording to the chosen
environment; nothing else about the project is sent.

## Clean up transcripts

**Transcript cleanup** is a separate choice and is off by default. When on, the
finished transcript and up to 1,024 characters each from before, inside, and
after your selection are sent to the cleanup model on the draft's environment,
which fixes punctuation, numbers, and spoken corrections such as "make it 42,
sorry, 24". Depending on the model, that can involve an external service. Audio is never
sent to it. Use the built-in instructions or write your own, press **Skip**
while cleanup runs to insert the raw transcript, and if cleanup fails the raw
transcript is inserted.

Cleanup uses the environment's text generation model unless you pick a
**Cleanup model** for that environment, for example a cheaper or faster one.
It can be a text generator instead of a coding agent; see
[text generation models](./text-generation.md).

If cleanup misses the way you correct yourself, set a **Correction cue**: the
word or phrase you say to flag a correction, such as "scratch that". Cleanup
applies the correction only where the context shows one and drops the cue, and
the model hears the cue as a dictionary hint.

## Test and troubleshoot

In **Settings → Voice**, voice input uses the first connected microphone in the
**Microphone** list. A microphone joins the list below System default the first
time it is seen, so nothing changes until you move it up. If a preferred
microphone is unplugged, the next connected one is used.

**Test microphone** records from that microphone for up to ten seconds and
plays it back in your browser; the audio stays on this device and is never transcribed, so silent playback
points at the microphone. **Test model** on the selected model shows a transcript using the
same environment, language, and dictionary as the composer, but skips transcript
cleanup even when it is on, so you see what the model heard. Browser recording
needs HTTPS or localhost and microphone permission; for a remote server over
plain HTTP, use the desktop app.
