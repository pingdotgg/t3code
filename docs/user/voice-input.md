# Voice input

On web and desktop, voice input transcribes speech on a connected T3 Code
environment. Finish dictation to insert text into your draft for review, or press
Send during dictation to send once the transcript is ready. Dictation is also
available in supported comment, pull request review, diff annotation, and desktop
browser annotation editors.

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. This uses Apple's on-device speech model instead of
the environment service; see [Voice input on iPhone](./composer.md#voice-input-on-iphone).
Android does not currently have built-in voice input.

## Set up web and desktop dictation

Open **Settings → Voice** to choose the transcription environment and download
and select a model. The primary environment is used by default, regardless of
which environment owns the current thread. If the selected environment is remote,
microphone audio is sent to that machine for transcription.

The first use opens voice setup if the selected environment has no transcription
model. Download the recommended English model, or open Voice settings to choose
another language or model. After the download, choose a microphone or start
dictating. Voice settings also lets you switch between downloaded models or
remove them from the environment.

Models vary in download size, supported languages, speed, and accuracy. Browsing
models by language helps you find a compatible model; **Transcription language**
chooses the language you speak. Choose **Auto** to detect it when the selected
model supports language detection. **Translate to English** converts speech into
English text when the model supports translation.

## Dictate into a draft

Start voice input with the microphone control, then finish to insert the transcript.
Cancel to discard the recording and preserve your draft. Recordings can be up to
five minutes long. In the composer, text is inserted at the cursor or replaces the
selection captured when recording starts. Editing is disabled while voice input
is running. Send becomes available once recording starts. Press Send to finish recording and send the completed draft, including
any existing text, after transcription and optional post-processing. You can also
press Send while those steps are finishing. In other supported editors, the
submit or save action works the same way. Cancelling dictation cancels the queued
action and preserves your draft.

Press `mod+shift+d` to start dictation and `Esc` to discard it. `mod` means Command
on macOS and Ctrl on Windows and Linux. The shortcut targets the focused supported
editor, or the composer when no supported editor is focused. The default **Auto**
shortcut mode lets you tap to keep recording until the next press, or hold the keys
and release to finish. In Voice settings, choose **Hold** to record only while the
keys are down, or **Toggle** to start and finish with separate presses. Change the
shortcut in [Keybindings settings](./keybindings.md).

Models marked **Streaming** show a live preview while you speak. The tentative
ending may change as the model hears more. Finish recording to insert the text;
cancel to discard the preview without changing your draft. Other models transcribe
after recording stops.

## Improve recognition

Add names, technical terms, and other uncommon vocabulary to the **Dictionary**.
The current project's name is included automatically when transcribing in its composer.
If transcription repeatedly writes a term differently, add that spelling as an alias
under the preferred term. Only preferred terms are sent as recognition hints; aliases
correct matching words and phrases in the transcript.

Select **All projects** to edit your personal dictionary on this client, or select
a project to edit vocabulary saved on its originating environments. Both dictionaries
are used together, even when transcription runs elsewhere. Project spellings take
precedence when dictionaries overlap. Each recording can use up to 100 personal
and project words combined.

**Remove filler words** deletes common hesitation sounds from completed
transcriptions while preserving ambiguous words when the language is uncertain.

### Optional transcript cleanup

Enable **Voice post-processing** in Voice settings to polish a completed transcript.
Cleanup runs through a provider configured on the thread's environment. Its model
is configured separately from the environment's general text generation model.
The transcript and existing draft context are sent to that provider to help resolve
recognition errors. Depending on the provider, this can involve an external service.

Choose the cleanup model and use the built-in prompt or write custom instructions
in Voice settings. Language, translation, filler removal, cleanup instructions,
and correction cues are saved on this client. The cleanup model is configured
separately on each thread's environment. Changes to personal preferences apply
to the next recording.

If cleanup misses your spoken corrections, add the word or phrase you use to signal
them as an **Explicit correction cue**. It is used to apply corrections when
post-processing is enabled. Select **Skip** during processing to insert the original
transcript instead. If processing fails, T3 Code preserves the original transcript.

## Check microphone and transcription problems

Allow microphone access when prompted. Browser recording requires HTTPS or
localhost and a browser that supports microphone capture and audio worklets.
For a remote server opened over plain HTTP, use an HTTPS client or the desktop app.

In **Settings → Voice**, use **Test mic** to record and play back your microphone,
then **Test model** to check recognition with the selected transcription model.
The model test runs without provider post-processing, so you can check recognition
separately from cleanup. If the selected microphone is unavailable, choose another
or use the system default. Make sure the transcription environment is connected
and its model is downloaded.

## Manage transcription resources

**Transcription acceleration** defaults to Auto, which uses a GPU when available.
Choose CPU to avoid GPU use, or select a specific GPU on the transcription
environment. If that GPU fails or becomes unavailable, transcription reports an
error instead of switching to CPU.

**Model unload** defaults to 15 minutes of inactivity on the selected environment.
Choose Never to keep the model ready until the environment stops, or Immediately
to release its memory after each transcription.
