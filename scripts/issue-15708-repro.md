# Reproduce a Claude steer interrupted behind a foreground tool

Use a disposable worktree and its isolated `.t3` state (`vp run dev`), never the live T3 home. Create a project in a disposable git-initialized directory. Pair a real client privately. Select Claude Sonnet 5.5 and Settings → Follow-up behavior → Steer. Native mobile can connect to the same isolated environment and inspect the persisted thread.

Run this disposable held endpoint in a separate terminal (Node; port must be free):

```sh
node --input-type=module -e 'import {createServer} from "node:http"; createServer((req,res)=>{console.log("held",req.url); const timer=setTimeout(()=>res.end("released"),600000); res.on("close",()=>clearTimeout(timer));}).listen(18708,"127.0.0.1")'
```

Send this exact first prompt in a new thread:

> Run this exact command with your Bash tool in the foreground, not in the background, and wait for it to finish: curl --silent --max-time 600 http://127.0.0.1:18708/held. Then reply with exactly the text it printed.

Wait for the provider protocol log's `system` / `task_started` frame with `is_backgrounded:false` for that Bash call (normally a few seconds). Logs are under the isolated `.t3/userdata/logs/provider/`; do not publish their private contents. While curl is still held, send:

> Codeword: PELICAN-FS28-15708. Remember it, I will ask for it later.

Then click Stop while the foreground tool is running. Before the fix the thread silently loses the steer. After the fix a system notice quotes the steer, says delivery could not be confirmed, and asks for resend; it does not claim that Claude remembers it. Record the complete interaction, including the task-start milestone and Stop, and inspect the notice in web and native mobile (including expanded detail).

No-Stop control: restart the endpoint with `30000` in place of `600000` so it releases well before curl's 600-second `--max-time`; with equal timeouts curl can expire first and the control stops testing a clean release. Repeat in a fresh thread, allow the endpoint to release, then ask for the codeword. Expect recall and no delivery warning.

Consumed-then-Stop control: ask Claude to run a short held curl, acknowledge the codeword, then run a second long held curl. Steer during the first curl, release it, wait for the acknowledgement and second foreground `task_started`, then Stop. Expect no unconfirmed-delivery warning for the acknowledged steer. Correlate its UUID with an assistant/stream/result prompt-UUID echo; a user echo alone is insufficient evidence.

For matched visual proof, run the same sequence on each source revision, use equal viewport/DPR/theme/font settings, and capture the whole surface. Persisted old threads viewed under new source are supplementary evidence, not proof of the old build. Keep databases, logs, screenshots, recordings, tokens, and pixel diffs outside git. Stop only the endpoint process started for this recipe.
