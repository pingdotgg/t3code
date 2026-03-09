# Codex CLI Installation for T3 Code

To use T3 Code, you need to install the Codex CLI tool from OpenAI.

## What You Need

- A **ChatGPT Plus, Pro, or paid account** (free accounts won't work)
- **Terminal access** (already installed on your computer)

## Installation

Install Codex using one of these methods:

**Option 1: npm (easiest)**

```bash
npm install -g @openai/codex
```

**Option 2: Homebrew (Mac only)**

```bash
brew install --cask codex
```

📖 **Official docs**: https://developers.openai.com/codex/cli

## Verify It Works

Open your terminal and run:

```bash
codex --version
```

You should see a version number. If it hangs for more than 5 seconds, something's wrong.

## Set Up Codex

1. **Run Codex once** to sign in:

   ```bash
   codex
   ```

2. **Follow the prompts** to open your browser and authorize

3. **Test it**:
   ```bash
   codex "hello"
   ```

## Using with T3 Code

**Desktop App:**

- Open T3 Code
- Go to **Settings → Provider Options**
- Codex should auto-detect if installed correctly

**If it doesn't detect:**

First, find your exact Codex path:

```bash
which codex        # Mac/Linux
where codex        # Windows
```

Then set that path in T3 Code settings.

**Common installation paths:**

- **Mac (npm)**: `/usr/local/bin/codex` or `~/.codex`
- **Mac (Homebrew - Intel)**: `/usr/local/bin/codex`
- **Mac (Homebrew - Apple Silicon)**: `/opt/homebrew/bin/codex`
- **Linux**: `/usr/local/bin/codex` or `~/.npm-global/bin/codex`
- **Windows**: `C:\Users\YourUsername\AppData\Roaming\npm\codex.cmd`

## Common Problems

### "command not found"

**Codex isn't in your system path.**

**Fix:**

```bash
# Mac/Linux - reinstall with npm
npm uninstall -g @openai/codex
npm install -g @openai/codex

# Windows - restart your terminal after installing
```

### Times out or hangs

**Codex isn't responding.**

**Fix:**

1. Test in terminal: `codex --version`
2. If it times out, reinstall: `npm install -g @openai/codex`
3. Check your internet connection

### "Permission denied"

**Codex can't run.**

**Fix:**

```bash
chmod +x $(which codex)
```

### Authentication errors

**You're not logged in.**

**Fix:**

```bash
codex auth login
codex auth status
```

## Platform Tips

**Mac:**

- Works on both Intel and Apple Silicon Macs
- May need to allow in "Security & Privacy" settings

**Windows:**

- Use PowerShell or Command Prompt
- Run as Administrator if needed

**Linux:**

- Works on all distributions
- Make sure the file is executable

## Need Help?

- **Official guide**: https://developers.openai.com/codex/docs/installation
- **Report issues**: https://github.com/pingdotgg/t3code/issues
