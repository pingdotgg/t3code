# Side chats

When a lesson raises a question, highlight the part you want to understand and choose **Ask in side chat**. The side chat opens beside the lesson with the highlight and its context. Choose **Done** when you are finished; the side chat leaves a note that the next lesson message can use. Sending a message in the lesson also finishes side chats you left open, unless one is still answering. Ask something in a finished side chat to reopen it; messages from scheduled tasks or agents wait in its queue until you do, or until you choose **Send now** on one. Side chats can nest, so follow a question as far as you need.

Reopen the usage tour from **Settings → About**, **Help → Welcome Guide**, or the command palette.

Side chats asked under a reply headed "Lesson 2" or a short section code such as "U2:" (as a heading, or a line that is only a bold title) are grouped under that section in the side-chat map; sections can be collapsed.

You can also highlight text inside an HTML embed, or use its corner button to ask about the whole embed.

Side chats work in the web and desktop apps. The mobile app doesn't support them yet; a lesson with side chats says so instead of listing them.

## Start a lesson

Choose **New lesson** beside New thread, find **New lesson** in the command palette, or highlight a reply and choose **Create a lesson**. Answer what you want to learn, how deep to go, and why. New lesson asks whether to keep the lesson in the current project or give it its own project under the lessons folder in the T3 home. Opened from a project's chat, New-thread page or project page, it starts on that project. T3 creates a lesson thread and starts teaching immediately; those answers become its first message. Lessons don't copy the open chat's model or access mode. New lesson starts with the model you last picked there on that server (otherwise your project's default model) and runs no higher than Auto access. Lessons and side chats never run at Ultracode, even when it is your default, so they teach in their own turn instead of waiting on background agents. A lesson made from a highlight keeps the passage and a link back to the source chat.

## Settings

Open **Settings → Threads → Side chats** to choose the model for new side chats, change how they explain things, and attach skills. Skills are added when a side chat starts where its provider supports them; a few providers can only see the skill name.

## What you know

OminaX keeps a per-environment map of topics you have explained back correctly. In a lesson, say `mark X done` and explain the topic in your own words. Review or remove entries in Settings → Threads → What you know. Mobile does not show this map yet.

The agent grades your explanation against its own full answer and says plainly what is missing; it saves only an explanation that holds. When you start a topic that isn't on the map, it asks one quick question first to find where to begin.

Say `practice X` (or `practice what I know`) for problems on topics from your map. The agent gives hints rather than answers and retests what you missed before ending. Practice never adds to the map.

## Pictures and animations

Lessons write the explanation first, then add a picture, an interactive demo, or a short animated clip when it helps, or when you ask ("draw it", "animate it"). Pictures and demos usually follow the text within one to three minutes, and clips within about a minute. Clips need Manim on the machine running OminaX; without it, the lesson shows a demo instead.

## Quizzes

Lessons and side chats can ask quiz cards or open-question cards. On web and desktop, an open question may also ask you to fill in blanks or give a number (the unit is shown beside the box, so type only the number); the app marks those right or wrong before the tutor replies. Pick an option, fill in the answer, or explain your thinking (with voice dictation on supported clients); your answer goes back to the current chat so it can respond. On mobile, quiz cards work as on the web; answer open questions in the chat.

## Follow a course

Paste an OCW or YouTube course link into New Lesson's "What do you want to learn?" box, or into any lesson, or attach a PDF to a lesson and ask to follow it. With no link, ask for "X as a course" and the lesson writes its own outline. The lesson posts the outline and prepares the current and next units (plans and quizzes) in a separate prep thread, so tell it where you are ("L4 23:10, why…") and it answers from that moment of the lecture. OCW lessons include their MIT OpenCourseWare credit. Fetching YouTube captions is off by default; turn it on in Settings → Threads → Courses (it needs a recent [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) on the machine running the server), or paste the transcript from YouTube's "Show transcript" panel. Remove saved courses from the same Courses section.
