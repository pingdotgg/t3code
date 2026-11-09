# Text generation models

T3 Code writes some text for you: thread titles, commit messages, pull request titles and
descriptions, branch names, review guides, and voice transcript cleanup. Each environment picks the
model for this in **Settings → Threads → Text generation model**. **Settings → Source control** and
**Settings → Voice** can pick a different model for their own tasks.

By default these models come from your coding agents, such as Codex or Claude. A coding agent
starts a full session for each request, so you can instead add a **text generator**: a model API
that only writes text. It is usually faster and costs fewer tokens.

## Add a text generator

In **Settings → Threads → Text generation**, choose **Add** next to **Text generators** and pick a
service:

- **OpenAI** or **Anthropic**, with an API key.
- **OpenRouter**, with an OpenRouter key, to use any model it serves.
- **OpenAI-compatible**, for any other endpoint, such as Ollama at `http://localhost:11434/v1`
  or LM Studio. A local server usually needs no key.

The key is stored on the environment like other [secrets](./secrets.md) and can point at a secret
provider. Its models then appear in each text generation model picker on that environment. The
model list is loaded the first time you open a picker; refresh it from the text generator's row
after the API adds models.

Requests go from the environment's server to the API you configured, and they include what the
task needs, such as the staged diff for a commit message.

## Limits

- Review guides need an agent that can read the checkout, so they always use a coding agent.
  Pick one in **Settings → Source control → Review guide model**.
- A [managed policy](./managed-policy.md) that limits providers also turns off text generators.
- Turning a text generator off, or removing it, sends its tasks back to the environment's text
  generation model.
