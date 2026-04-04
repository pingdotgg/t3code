# Game Plan: Claude Code CLI from T3 Code Fork

## Goal
Fork T3 Code and build a CLI interface that mimics Claude Code's workflow, reusing T3's existing agentic architecture while adding terminal UI.

---

**Key files to understand:**
```
t3code/
├── app/api/           # Next.js API routes - EXTRACT LOGIC
├── lib/
│   ├── ai/            # Claude integration - REUSE
│   ├── files/         # File operations - REUSE
│   └── planning/      # Agentic workflow - REUSE
└── components/        # React UI - REPLACE with CLI
```

---

## Phase 1: Minimal CLI Setup (Days 0)

### 1.1 Add CLI Directory (Keep T3 Code Untouched!)

**CRITICAL: The existing T3 Code web app must remain 100% unchanged.**

Create a minimal CLI addition:

```
t3code/                    # Existing T3 Code (UNCHANGED)
├── app/                   # Next.js web app (UNCHANGED)
├── lib/                   # Existing utilities (UNCHANGED)
├── components/            # React components (UNCHANGED)
├── cli/                   # NEW - CLI interface only
│   ├── src/
│   │   ├── ui/            # Ink terminal components
│   │   ├── commands/      # CLI command handlers
│   │   ├── adapters/      # Adapters to reuse T3's code
│   │   └── index.ts       # CLI entry point
│   ├── package.json       # CLI dependencies
│   └── tsconfig.json      # CLI TypeScript config
├── package.json           # Root package (add CLI scripts)
└── cli-gameplan.md        # This file
```

### 1.2 Create CLI Package Configuration

**Add CLI as a separate entry point without touching existing code:**

```json
// cli/package.json
{
  "name": "t3code-cli",
  "version": "1.0.0",
  "bin": {
    "t3code": "./dist/index.js",
    "t3": "./dist/index.js"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "dev": "tsup src/index.ts --format esm --watch --onSuccess 'node dist/index.js'",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.20.0",
    "commander": "^11.1.0",
    "ink": "^4.4.1",
    "ink-text-input": "^5.0.1",
    "ink-spinner": "^5.0.0",
    "ink-select-input": "^5.0.0",
    "react": "^18.2.0",
    "chalk": "^5.3.0",
    "diff": "^5.1.0",
    "conf": "^12.0.0",
    "ora": "^7.0.1"
  }
}
```

```json
// cli/tsconfig.json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "baseUrl": ".",
    "paths": {
      "@/*": ["../lib/*"],          // Import from T3's lib
      "@/app/*": ["../app/*"]       // Import from T3's app
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 1.3 Reuse T3 Code via Adapters

Instead of extracting code, create adapters that import from existing T3 files:

```typescript
// cli/src/adapters/claude-adapter.ts

// Import T3's existing Claude integration
import { streamResponse } from '@/app/api/chat/route';
import type { Message } from '@/lib/types';

/**
 * Adapter to use T3's existing Claude API logic from the CLI
 * No code duplication - just wraps existing functionality
 */
export class ClaudeAdapter {
  async *streamCodeGeneration(
    messages: Message[],
    workingDir: string
  ) {
    // Reuse T3's streaming logic
    const response = await streamResponse({
      messages,
      workingDirectory: workingDir,
    });

    // Convert web response to CLI-friendly events
    for await (const chunk of response) {
      yield this.adaptChunk(chunk);
    }
  }

  private adaptChunk(webChunk: any) {
    // Convert web format to CLI format
    return {
      type: webChunk.type,
      content: webChunk.content,
    };
  }
}
```

```typescript
// cli/src/adapters/file-adapter.ts

// Import T3's file operations
import { readFile, writeFile, scanWorkspace } from '@/lib/files';

/**
 * Adapter for T3's file operations - no reimplementation needed
 */
export class FileAdapter {
  constructor(private workingDir: string) {}

  async scan() {
    // Reuse T3's existing workspace scanner
    return await scanWorkspace(this.workingDir);
  }

  async read(path: string) {
    // Reuse T3's file reader
    return await readFile(path, this.workingDir);
  }

  async write(path: string, content: string) {
    // Reuse T3's file writer
    return await writeFile(path, content, this.workingDir);
  }
}
```

### 1.4 Update Root Package.json (Minimal Change)

Only add CLI scripts to root package.json, don't change existing scripts:

```json
// package.json (root) - ADD these scripts only
{
  "scripts": {
    // ... existing T3 scripts remain unchanged ...
    "cli:dev": "cd cli && npm run dev",
    "cli:build": "cd cli && npm run build",
    "cli:start": "cd cli && npm run start"
  }
}
```

---

## Phase 2: CLI Entry Point (Days 4-5)

### 2.1 CLI Entry Point

```typescript
// cli/src/index.ts
#!/usr/bin/env node

import { Command } from 'commander';
import { startCodeSession } from './commands/start';
import { continueSession } from './commands/continue';
import { configureAPI } from './commands/config';

const program = new Command();

program
  .name('t3code')
  .description('AI pair programmer powered by Claude (T3 Code CLI)')
  .version('1.0.0');

program
  .command('start')
  .description('Start coding session in current directory')
  .option('-d, --directory <path>', 'Working directory', process.cwd())
  .action(startCodeSession);

program
  .command('continue')
  .description('Continue previous session')
  .action(continueSession);

program
  .command('config')
  .description('Configure API key and settings')
  .action(configureAPI);

// Default command (no subcommand = start)
program
  .action(() => {
    startCodeSession({ directory: process.cwd() });
  });

program.parse();
```

### 2.2 Main Session Command (Using Adapters)

```typescript
// cli/src/commands/start.ts

import React from 'react';
import { render } from 'ink';
import { MainApp } from '../ui/MainApp';
import { ClaudeAdapter } from '../adapters/claude-adapter';
import { FileAdapter } from '../adapters/file-adapter';
import { ConfigManager } from '../config/ConfigManager';

export async function startCodeSession(options: { directory: string }) {
  // Load API key
  const config = new ConfigManager();
  const apiKey = await config.getApiKey();

  if (!apiKey) {
    console.log('No API key found. Run: t3code config');
    process.exit(1);
  }

  // Initialize adapters that wrap T3's existing code
  const fileAdapter = new FileAdapter(options.directory);
  const claudeAdapter = new ClaudeAdapter(apiKey);

  // Scan workspace using T3's logic
  const context = await fileAdapter.scan();

  // Render Ink UI
  render(
    <MainApp
      fileAdapter={fileAdapter}
      claudeAdapter={claudeAdapter}
      context={context}
    />
  );
}
```

---

## Phase 3: Terminal UI (Days 6-7)

### 3.1 Main App Component

```typescript
// cli/src/ui/MainApp.tsx

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatView } from './components/ChatView';
import { DiffView } from './components/DiffView';
import { ExecutionView } from './components/ExecutionView';
import type { ClaudeAdapter } from '../adapters/claude-adapter';
import type { FileAdapter } from '../adapters/file-adapter';

type Mode = 'welcome' | 'chat' | 'executing' | 'diff' | 'done';

export const MainApp: React.FC<MainAppProps> = ({
  fileAdapter,
  claudeAdapter,
  context,
}) => {
  const [mode, setMode] = useState<Mode>('welcome');
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingChanges, setPendingChanges] = useState<FileChange[]>([]);
  const { exit } = useApp();

  // Global keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
    if (key.ctrl && input === 'd') {
      exit();
    }
  });

  useEffect(() => {
    // Auto-transition from welcome to chat after 2s
    if (mode === 'welcome') {
      const timer = setTimeout(() => setMode('chat'), 2000);
      return () => clearTimeout(timer);
    }
  }, [mode]);

  return (
    <Box flexDirection="column" paddingX={2}>
      {mode === 'welcome' && (
        <WelcomeScreen
          workingDir={context.workingDirectory}
          onReady={() => setMode('chat')}
        />
      )}

      {mode === 'chat' && (
        <ChatView
          messages={messages}
          onSubmit={(userMessage) => handleUserMessage(userMessage)}
        />
      )}

      {mode === 'executing' && (
        <ExecutionView
          currentStep="Planning changes..."
        />
      )}

      {mode === 'diff' && (
        <DiffView
          changes={pendingChanges}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {mode === 'done' && (
        <Box>
          <Text color="green">✓ Changes applied successfully!</Text>
        </Box>
      )}
    </Box>
  );

  async function handleUserMessage(userMessage: string) {
    setMode('executing');

    const newMessages = [
      ...messages,
      { role: 'user', content: userMessage, timestamp: Date.now() }
    ];
    setMessages(newMessages);

    // Stream response from adapter (which uses T3's code)
    const events = claudeAdapter.streamCodeGeneration(
      newMessages,
      context.workingDirectory
    );

    const responseChunks: string[] = [];
    const toolUses: ToolUse[] = [];

    for await (const event of events) {
      if (event.type === 'text') {
        responseChunks.push(event.text);
      } else if (event.type === 'tool_use') {
        const result = await handleToolUse(event.toolUse);
        toolUses.push(result);
      }
    }

    setMessages([
      ...newMessages,
      {
        role: 'assistant',
        content: responseChunks.join(''),
        toolUse: toolUses,
        timestamp: Date.now(),
      }
    ]);

    if (pendingChanges.length > 0) {
      setMode('diff');
    } else {
      setMode('chat');
    }
  }

  async function handleToolUse(toolUse: ToolUse) {
    if (toolUse.name === 'write_file') {
      // Queue change instead of applying immediately
      const originalContent = await fileAdapter.read(toolUse.input.path)
        .catch(() => undefined);

      setPendingChanges(prev => [...prev, {
        type: originalContent ? 'modify' : 'create',
        path: toolUse.input.path,
        newContent: toolUse.input.content,
        originalContent,
      }]);

      return { success: true, queued: true };
    }
    // Handle other tools...
  }

  async function handleApprove() {
    // Use T3's file operations via adapter
    for (const change of pendingChanges) {
      await fileAdapter.write(change.path, change.newContent);
    }
    setPendingChanges([]);
    setMode('done');
  }

  function handleReject() {
    setPendingChanges([]);
    setMode('chat');
  }
};
```

### 3.2 Welcome Screen

```typescript
// cli/src/ui/components/WelcomeScreen.tsx

import React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  workingDir,
  onReady,
}) => {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Gradient name="rainbow">
        <BigText text="T3 Code CLI" font="tiny" />
      </Gradient>

      <Box marginTop={1}>
        <Text dimColor>Working directory: </Text>
        <Text color="cyan">{workingDir}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">
          I can help you build, refactor, and debug your code.
        </Text>
        <Text color="gray" marginTop={1}>
          Just tell me what you'd like to do...
        </Text>
      </Box>
    </Box>
  );
};
```

### 3.3 Chat View

```typescript
// cli/src/ui/components/ChatView.tsx

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export const ChatView: React.FC<ChatViewProps> = ({
  messages,
  onSubmit,
}) => {
  const [input, setInput] = useState('');

  return (
    <Box flexDirection="column">
      {/* Message history */}
      <Box flexDirection="column" marginBottom={1}>
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
      </Box>

      {/* Input area */}
      <Box>
        <Text color="cyan">→ </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(value) => {
            onSubmit(value);
            setInput('');
          }}
          placeholder="What would you like to build?"
        />
      </Box>

      {/* Footer hints */}
      <Box marginTop={1}>
        <Text dimColor>Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
};

const MessageBubble: React.FC<{ message: Message }> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={isUser ? 'blue' : 'green'}>
        {isUser ? 'You' : 'Claude'}
      </Text>
      <Text>{message.content}</Text>

      {message.toolUse && message.toolUse.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {message.toolUse.map((tool, i) => (
            <Text key={i} dimColor>
              → {tool.name}({JSON.stringify(tool.input).slice(0, 50)}...)
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
```

### 3.4 Diff Viewer

```typescript
// cli/src/ui/components/DiffView.tsx

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { diffLines } from 'diff';

export const DiffView: React.FC<DiffViewerProps> = ({
  changes,
  onApprove,
  onReject,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [approved, setApproved] = useState<Set<number>>(new Set());

  useInput((input, key) => {
    if (input === 'y') {
      setApproved(prev => new Set([...prev, currentIndex]));
      if (currentIndex < changes.length - 1) {
        setCurrentIndex(currentIndex + 1);
      } else {
        onApprove();
      }
    } else if (input === 'n') {
      if (currentIndex < changes.length - 1) {
        setCurrentIndex(currentIndex + 1);
      } else {
        onReject();
      }
    } else if (input === 'a') {
      onApprove();
    } else if (input === 'r') {
      onReject();
    } else if (key.downArrow || input === 'j') {
      if (currentIndex < changes.length - 1) {
        setCurrentIndex(currentIndex + 1);
      }
    } else if (key.upArrow || input === 'k') {
      if (currentIndex > 0) {
        setCurrentIndex(currentIndex - 1);
      }
    }
  });

  const currentChange = changes[currentIndex];

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>
          Review Changes ({currentIndex + 1}/{changes.length})
        </Text>
      </Box>

      {/* File diff */}
      <FileDiff change={currentChange} />

      {/* Controls */}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="green">[y]</Text> approve this file
          <Text color="red"> [n]</Text> skip this file
        </Text>
        <Text>
          <Text color="green">[a]</Text> approve all
          <Text color="red"> [r]</Text> reject all
          <Text> [j/k]</Text> next/prev
        </Text>
      </Box>

      {/* Progress */}
      <Box marginTop={1}>
        {changes.map((_, i) => (
          <Text key={i} color={
            approved.has(i) ? 'green' :
            i === currentIndex ? 'cyan' :
            'gray'
          }>
            {approved.has(i) ? '✓' : i === currentIndex ? '●' : '○'}
          </Text>
        ))}
      </Box>
    </Box>
  );
};

const FileDiff: React.FC<{ change: FileChange }> = ({ change }) => {
  const diff = diffLines(
    change.originalContent || '',
    change.newContent || ''
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray">
      <Box paddingX={1}>
        <Text bold color="cyan">{change.path}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {diff.map((part, i) => (
          <Text
            key={i}
            color={part.added ? 'green' : part.removed ? 'red' : 'white'}
            backgroundColor={part.added ? 'greenBright' : part.removed ? 'redBright' : undefined}
          >
            {part.added ? '+ ' : part.removed ? '- ' : '  '}
            {part.value}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
```

---

## Phase 4: Tool Integration (Days 8-9)

### 4.1 Tool Definitions (Reuse from T3)

```typescript
// cli/src/tools/definitions.ts

// Import tool definitions from T3's existing code
import { tools as t3Tools } from '@/lib/tools';

// Re-export for CLI use
export const tools = t3Tools;

// Or if T3 doesn't have them exported, define them here:
export const tools = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the workspace',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from workspace root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (queued for approval)',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file',
        },
        content: {
          type: 'string',
          description: 'Full content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list',
        },
      },
      required: ['path'],
    },
  },
];
```

### 4.2 Tool Handler (Wraps T3's Logic)

```typescript
// cli/src/tools/handler.ts

import { FileAdapter } from '../adapters/file-adapter';

export class ToolHandler {
  constructor(
    private fileAdapter: FileAdapter,
    private pendingChanges: FileChange[],
  ) {}

  async handleToolUse(toolUse: ToolUse): Promise<ToolResult> {
    switch (toolUse.name) {
      case 'read_file':
        return await this.handleReadFile(toolUse.input);

      case 'write_file':
        return await this.handleWriteFile(toolUse.input);

      case 'list_directory':
        return await this.handleListDirectory(toolUse.input);

      default:
        throw new Error(`Unknown tool: ${toolUse.name}`);
    }
  }

  private async handleReadFile(input: { path: string }) {
    // Use T3's file reading via adapter
    const content = await this.fileAdapter.read(input.path);
    return {
      type: 'text',
      text: content,
    };
  }

  private async handleWriteFile(input: { path: string; content: string }) {
    // Don't write immediately - queue for approval (Claude Code style)
    const originalContent = await this.fileAdapter.read(input.path)
      .catch(() => undefined);

    this.pendingChanges.push({
      type: originalContent ? 'modify' : 'create',
      path: input.path,
      originalContent,
      newContent: input.content,
    });

    return {
      type: 'text',
      text: `File ${input.path} queued for review`,
    };
  }

  private async handleListDirectory(input: { path: string }) {
    // Could reuse T3's directory listing if it exists
    const files = await this.fileAdapter.listDirectory(input.path);
    return {
      type: 'text',
      text: JSON.stringify(files, null, 2),
    };
  }
}
```

---

## Phase 5: Session Management (Day 10)

### 5.1 Session Persistence

```typescript
// cli/src/session/SessionManager.ts

import Conf from 'conf';
import * as path from 'path';

export class SessionManager {
  private config: Conf;

  constructor(workingDir: string) {
    this.config = new Conf({
      projectName: 't3code-cli',
      cwd: workingDir,
      configName: '.t3code-session',
    });
  }

  async saveSession(session: CodeSession): Promise<void> {
    await this.config.set('session', {
      ...session,
      savedAt: Date.now(),
    });
  }

  async loadSession(): Promise<CodeSession | null> {
    const session = this.config.get('session') as CodeSession | undefined;
    return session || null;
  }

  async clearSession(): Promise<void> {
    this.config.delete('session');
  }

  hasActiveSession(): boolean {
    return this.config.has('session');
  }
}
```

### 5.2 Continue Command

```typescript
// cli/src/commands/continue.ts

import React from 'react';
import { render } from 'ink';
import { MainApp } from '../ui/MainApp';
import { SessionManager } from '../session/SessionManager';

export async function continueSession() {
  const sessionManager = new SessionManager(process.cwd());

  if (!sessionManager.hasActiveSession()) {
    console.log('No active session found in this directory.');
    console.log('Start a new session with: t3code start');
    process.exit(1);
  }

  const session = await sessionManager.loadSession();

  console.log(`Continuing session from ${new Date(session.savedAt).toLocaleString()}`);
  console.log(`Last task: ${session.currentTask || 'N/A'}\n`);

  // Initialize and render with existing session
  render(
    <MainApp
      initialSession={session}
      // ... other props
    />
  );
}
```

---

## Phase 6: Polish & Distribution (Days 11-12)

### 6.1 Configuration Manager

```typescript
// cli/src/config/ConfigManager.ts

import Conf from 'conf';
import prompts from 'prompts';

export class ConfigManager {
  private config: Conf;

  constructor() {
    this.config = new Conf({
      projectName: 't3code-cli',
    });
  }

  async getApiKey(): Promise<string | null> {
    return this.config.get('apiKey') as string || null;
  }

  async setApiKey(apiKey: string): Promise<void> {
    this.config.set('apiKey', apiKey);
  }

  async runSetup(): Promise<void> {
    console.log('T3 Code CLI - Configuration\n');

    const { apiKey } = await prompts({
      type: 'password',
      name: 'apiKey',
      message: 'Enter your Anthropic API key:',
      validate: (value) => value.length > 0 || 'API key is required',
    });

    await this.setApiKey(apiKey);
    console.log('\n✓ Configuration saved!');
    console.log('Start coding with: t3code start\n');
  }
}
```

### 6.2 Error Handling

```typescript
// cli/src/utils/error-handler.ts

export class ErrorHandler {
  static async handle(error: Error, context?: any): Promise<void> {
    console.error('\n❌ An error occurred:\n');

    if (error.message.includes('API key')) {
      console.error('Invalid or missing API key.');
      console.error('Run: t3code config\n');
    } else if (error.message.includes('rate limit')) {
      console.error('Rate limit exceeded. Please wait and try again.\n');
    } else if (error.message.includes('ENOENT')) {
      console.error('File not found:', error.message);
    } else {
      console.error(error.message);
      if (process.env.DEBUG) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    }

    process.exit(1);
  }
}
```

### 6.3 Build Configuration

```typescript
// cli/tsup.config.ts

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
```

### 6.4 Publishing Setup

```json
// cli/package.json (publishing fields)
{
  "name": "t3code-cli",
  "version": "1.0.0",
  "description": "T3 Code - AI pair programmer CLI powered by Claude",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/t3code"
  },
  "keywords": [
    "t3code",
    "claude",
    "ai",
    "coding",
    "assistant",
    "cli",
    "anthropic"
  ],
  "files": [
    "dist"
  ]
}
```

---

## Testing Strategy

### Manual Test Checklist

```markdown
## Core Functionality
- [ ] Fresh session in new directory
- [ ] Fresh session in existing codebase
- [ ] Continue existing session
- [ ] API key configuration

## File Operations
- [ ] Create new file
- [ ] Modify existing file
- [ ] Delete file
- [ ] Read file
- [ ] List directory
- [ ] Search files by pattern

## Approval Flow
- [ ] Review single file change
- [ ] Review multiple file changes
- [ ] Approve all changes
- [ ] Reject all changes
- [ ] Approve some, reject others
- [ ] Navigate between files (j/k)

## Error Scenarios
- [ ] Invalid API key
- [ ] Missing file
- [ ] Permission errors
- [ ] Network errors
- [ ] Rate limiting
- [ ] Interrupt during execution (Ctrl+C)

## Edge Cases
- [ ] Binary files
- [ ] Large files (>1MB)
- [ ] Symlinks
- [ ] .gitignore respecting
- [ ] Deeply nested directories
- [ ] Files with special characters

## UX
- [ ] Spinner animations smooth
- [ ] Diff colors correct
- [ ] Keyboard shortcuts work
- [ ] Welcome screen displays
- [ ] Session persistence works
```

---

## Timeline Summary

| Phase | Days | Key Deliverables |
|-------|------|------------------|
| 0 - Research | 1 | UX understanding, T3 audit complete |
| 1 - Minimal Setup | 2 | `cli/` directory, adapters wrapping T3 code |
| 2 - CLI Entry | 2 | CLI commands, config working |
| 3 - Terminal UI | 2 | All Ink components built |
| 4 - Tool Integration | 2 | Tools reusing T3's logic |
| 5 - Sessions | 1 | Persistence, continue command |
| 6 - Polish | 2 | Config, errors, publishing |
| **TOTAL** | **12 days** | **Production-ready CLI** |

---

## Success Metrics

✅ **UX**: 90%+ match to Claude Code's flow
✅ **Code Reuse**: 80%+ of T3's logic preserved via adapters
✅ **Non-invasive**: T3 web app continues working unchanged
✅ **Performance**: Sub-second response times
✅ **Reliability**: Graceful error handling, no data loss

---

## Implementation Strategy

### Keep T3 Code Intact

**What NOT to do:**
- ❌ Don't create a monorepo
- ❌ Don't extract code into `packages/core`
- ❌ Don't refactor T3's existing code
- ❌ Don't modify T3's `package.json` scripts (only add CLI scripts)

**What TO do:**
- ✅ Add `cli/` directory at root
- ✅ Create adapters that import from T3's `lib/` and `app/`
- ✅ Keep both web and CLI working side-by-side
- ✅ CLI is purely additive

### Code Reuse Pattern

```typescript
// Bad: Extracting/duplicating T3's code
export class FileManager {
  async readFile() {
    // Reimplementing T3's file reading logic...
  }
}

// Good: Wrapping T3's existing code
import { readFile } from '@/lib/files';

export class FileAdapter {
  async read(path: string) {
    // Reuse T3's implementation
    return await readFile(path);
  }
}
```

---

## Key Differences from T3 Code

| Aspect | T3 Code (Web) | T3 Code CLI |
|--------|---------------|-------------|
| UI | React in browser | Ink in terminal |
| Input | Form submissions | stdin/readline |
| Approval | Click buttons | Keyboard shortcuts (y/n) |
| Diff | Side-by-side view | Line-by-line terminal |
| Session | Server-side state | Local JSON file |
| Tools | API routes | Adapters wrapping same logic |
| Code Sharing | N/A | Imports from `lib/` and `app/` |

---

## Next Steps

### Day 1 Morning
1. ✅ Install and test Claude Code for 2 hours
2. ✅ Document every interaction pattern
3. ✅ Clone T3 Code and explore codebase
4. ✅ Add this gameplan as `cli-gameplan.md`

### Day 1 Afternoon
5. Map T3's reusable code (what's in `lib/`, `app/api/`)
6. Identify which functions to wrap in adapters
7. Create `cli/` directory structure

### Day 2
8. Create adapter stubs for Claude API
9. Create adapter stubs for file operations
10. Set up CLI entry point with commander

Ready to start? The key principle: **Wrap, don't extract. Reuse, don't rewrite.**
