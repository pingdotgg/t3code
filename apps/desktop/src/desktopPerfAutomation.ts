// oxlint-disable no-await-in-loop
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrowserWindow, contentTracing, type WebContents } from "electron";
import {
  resolveBenchmarkFollowUpPassCount,
  shouldRunBenchmarkThreadSweep,
  shouldRunOptionalRendererPerfInteractions,
  shouldRunTerminalPerfInteractions,
} from "./perfConfig";

const PERF_AUTOMATION_ENABLED = process.env.T3CODE_DESKTOP_PERF_AUTOMATION === "1";
const PERF_TRACE_OUT_PATH = process.env.T3CODE_DESKTOP_PERF_TRACE_OUT?.trim() ?? "";
const PERF_DONE_OUT_PATH = process.env.T3CODE_DESKTOP_PERF_DONE_OUT?.trim() ?? "";
const PERF_SEED_PATH = process.env.T3CODE_DESKTOP_PERF_SEED_PATH?.trim() ?? "";
const RUN_TERMINAL_INTERACTIONS = shouldRunTerminalPerfInteractions({
  T3CODE_DESKTOP_PERF_RUN_TERMINAL: process.env.T3CODE_DESKTOP_PERF_RUN_TERMINAL,
  CI: process.env.CI,
});
const RUN_OPTIONAL_RENDERER_INTERACTIONS = shouldRunOptionalRendererPerfInteractions({
  T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER: process.env.T3CODE_DESKTOP_PERF_RUN_OPTIONAL_RENDERER,
  CI: process.env.CI,
});
const BENCHMARK_FOLLOW_UP_PASS_COUNT = resolveBenchmarkFollowUpPassCount({
  T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES:
    process.env.T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES,
  CI: process.env.CI,
});
const RUN_BENCHMARK_THREAD_SWEEP = shouldRunBenchmarkThreadSweep({
  T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP: process.env.T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP,
  CI: process.env.CI,
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label} (${timeoutMs}ms).`));
    }, timeoutMs);
    timeout.unref();

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function waitForDidFinishLoad(
  webContents: WebContents,
  options?: { timeoutMs?: number; label?: string },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const label = options?.label ?? "renderer load";

  if (!webContents.isLoadingMainFrame()) {
    const currentUrl = webContents.getURL();
    if (currentUrl.length === 0 || currentUrl.startsWith("chrome-error://")) {
      return Promise.reject(
        new Error(`${label} is not loading and no valid page is currently loaded (${currentUrl}).`),
      );
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      webContents.removeListener("did-finish-load", onLoad);
      webContents.removeListener("did-fail-load", onFailLoad);
      clearTimeout(timeout);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onLoad = () => {
      finish(resolve);
    };
    const onFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      finish(() => {
        reject(
          new Error(
            `${label} failed for ${validatedURL || "(unknown url)"} [${errorCode}] ${errorDescription}`,
          ),
        );
      });
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for ${label} (${timeoutMs}ms).`)));
    }, timeoutMs);
    timeout.unref();

    webContents.on("did-fail-load", onFailLoad);
    webContents.once("did-finish-load", onLoad);
  });
}

interface PerfPersistedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  streaming: false;
}

interface PerfPersistedThread {
  id: string;
  projectId: string;
  title: string;
  model: string;
  terminalOpen: false;
  messages: PerfPersistedMessage[];
  createdAt: string;
  lastVisitedAt: string;
}

interface PerfPersistedProject {
  id: string;
  name: string;
  cwd: string;
  model: string;
  expanded: true;
}

interface PerfPersistedState {
  version: 7;
  runtimeMode: "approval-required";
  projects: PerfPersistedProject[];
  threads: PerfPersistedThread[];
  activeThreadId: string | null;
}

const LARGE_THREAD_EXCHANGE_COUNT = 120;
const BENCHMARK_THREAD_COUNT = 2;
const BENCHMARK_TITLE_PREVIEW_LENGTH = 15;

interface PerfThreadStat {
  id: string;
  title: string;
  messageCount: number;
}

interface ResolvedPerfSeed {
  source: string;
  resolvedPath: string | null;
  state: unknown;
  projectCount: number;
  threadCount: number;
  benchmarkThreads: PerfThreadStat[];
}

interface PerfLargeThreadRenderStat {
  threadId: string;
  messageCount: number;
  firstRenderMs: number;
  followUpRenderMs: number;
  followUpMinMs: number;
  followUpMaxMs: number;
  followUpSampleCount: number;
  deltaMs: number;
  deltaPct: number;
}

interface RendererPerfInteractions {
  threadClicks: number;
  typedChars: number;
  selectedModel: string | null;
  largeThreadRenderStats: PerfLargeThreadRenderStat[];
  benchmarkThreadIds: string[];
}

interface TerminalPerfInteractions {
  openedByShortcut: boolean;
  splitCount: number;
  commandMarker: string;
  commandEchoObserved: boolean;
  commandFileTouched: boolean;
  modifierUsed: "meta" | "control";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectThreadStats(state: unknown): PerfThreadStat[] {
  if (!isRecord(state)) return [];
  const threads = state.threads;
  if (!Array.isArray(threads)) return [];

  const stats: PerfThreadStat[] = [];
  for (const thread of threads) {
    if (!isRecord(thread)) continue;
    const id = typeof thread.id === "string" ? thread.id : "";
    if (id.length === 0) continue;
    const title = typeof thread.title === "string" ? thread.title : "";
    const messages = thread.messages;
    const messageCount = Array.isArray(messages) ? messages.length : 0;
    stats.push({ id, title, messageCount });
  }

  return stats;
}

function pickBenchmarkThreads(stats: PerfThreadStat[], benchmarkAll: boolean): PerfThreadStat[] {
  const sorted = stats.toSorted((a, b) => b.messageCount - a.messageCount);
  return benchmarkAll ? sorted : sorted.slice(0, BENCHMARK_THREAD_COUNT);
}

function toTitlePreview(title: string): string {
  return title.slice(0, BENCHMARK_TITLE_PREVIEW_LENGTH);
}

function resolvePerfSeed(): ResolvedPerfSeed {
  if (PERF_SEED_PATH.length === 0) {
    const generated = buildPerfSeedState();
    const stats = collectThreadStats(generated);
    return {
      source: "generated",
      resolvedPath: null,
      state: generated,
      projectCount: generated.projects.length,
      threadCount: generated.threads.length,
      benchmarkThreads: pickBenchmarkThreads(stats, false),
    };
  }

  const resolvedPath = path.isAbsolute(PERF_SEED_PATH)
    ? PERF_SEED_PATH
    : path.resolve(process.cwd(), PERF_SEED_PATH);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Perf seed file not found: ${resolvedPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse perf seed JSON at ${resolvedPath}: ${message}`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Perf seed must be a JSON object: ${resolvedPath}`);
  }
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`Perf seed is missing "projects" array: ${resolvedPath}`);
  }
  if (!Array.isArray(parsed.threads)) {
    throw new Error(`Perf seed is missing "threads" array: ${resolvedPath}`);
  }

  const stats = collectThreadStats(parsed);
  return {
    source: "file",
    resolvedPath,
    state: parsed,
    projectCount: parsed.projects.length,
    threadCount: parsed.threads.length,
    benchmarkThreads: pickBenchmarkThreads(stats, false),
  };
}

function buildLargeThreadMessage(
  projectName: string,
  exchangeIndex: number,
  role: "user" | "assistant",
): string {
  if (role === "user") {
    return [
      `Large-thread perf scenario ${exchangeIndex + 1} for ${projectName}.`,
      "Please audit render cost while scrolling and switching among heavy histories.",
      "Include hotspots in markdown rendering, timeline grouping, and message list virtualization candidates.",
      "Track regressions across interaction loops and report any long-task spikes.",
    ].join("\n");
  }

  return [
    `### Perf analysis batch ${exchangeIndex + 1}`,
    "",
    "- Checked keypress/input dispatch cost and scheduler churn.",
    "- Compared component update cadence before/after thread switch.",
    "- Captured timeline and branch/tool state snapshots.",
    "",
    "```txt",
    `project=${projectName}`,
    `batch=${exchangeIndex + 1}`,
    "status=stable",
    "focus=render-throughput",
    "```",
    "",
    "Observed stable behavior under bursty UI events; continue profiling for long-thread rendering regressions.",
  ].join("\n");
}

function buildLargePerfThread(project: PerfPersistedProject, now: number): PerfPersistedThread {
  const threadId = `${project.id}-thread-large`;
  const createdAt = new Date(now - 1_500_000).toISOString();
  const messages: PerfPersistedMessage[] = [];
  for (let exchangeIndex = 0; exchangeIndex < LARGE_THREAD_EXCHANGE_COUNT; exchangeIndex += 1) {
    const offsetMs = (LARGE_THREAD_EXCHANGE_COUNT - exchangeIndex) * 11_000;
    messages.push({
      id: `${threadId}-user-${exchangeIndex + 1}`,
      role: "user",
      text: buildLargeThreadMessage(project.name, exchangeIndex, "user"),
      createdAt: new Date(now - offsetMs - 2_000).toISOString(),
      streaming: false,
    });
    messages.push({
      id: `${threadId}-assistant-${exchangeIndex + 1}`,
      role: "assistant",
      text: buildLargeThreadMessage(project.name, exchangeIndex, "assistant"),
      createdAt: new Date(now - offsetMs).toISOString(),
      streaming: false,
    });
  }

  return {
    id: threadId,
    projectId: project.id,
    title: `${project.name} perf large thread`,
    model: "gpt-5-codex",
    terminalOpen: false,
    messages,
    createdAt,
    lastVisitedAt: new Date(now - 1_000_000).toISOString(),
  };
}

function buildPerfSeedState(): PerfPersistedState {
  const now = Date.now();
  const projects: PerfPersistedProject[] = [
    {
      id: "perf-project-1",
      name: "codething-mvp",
      cwd: "/tmp/perf/codething-mvp",
      model: "gpt-5-codex",
      expanded: true,
    },
    {
      id: "perf-project-2",
      name: "contracts-bench",
      cwd: "/tmp/perf/contracts-bench",
      model: "gpt-5-codex",
      expanded: true,
    },
  ];

  const threads: PerfPersistedThread[] = [];
  let threadOrdinal = 0;

  for (const project of projects) {
    for (let threadIndex = 0; threadIndex < 5; threadIndex += 1) {
      const threadId = `${project.id}-thread-${threadIndex + 1}`;
      const threadCreatedAt = new Date(now - (threadOrdinal + 1) * 45_000).toISOString();
      const messages: PerfPersistedMessage[] = [];
      const exchangeCount = 6;
      for (let exchangeIndex = 0; exchangeIndex < exchangeCount; exchangeIndex += 1) {
        const msgBaseOffsetMs =
          (threadOrdinal * exchangeCount + exchangeIndex + 1) * 4_500 + threadIndex * 850;
        const userCreatedAt = new Date(now - msgBaseOffsetMs - 1_500).toISOString();
        const assistantCreatedAt = new Date(now - msgBaseOffsetMs).toISOString();
        messages.push({
          id: `${threadId}-user-${exchangeIndex + 1}`,
          role: "user",
          text: `Investigate renderer performance pattern ${exchangeIndex + 1} for ${project.name}.`,
          createdAt: userCreatedAt,
          streaming: false,
        });
        messages.push({
          id: `${threadId}-assistant-${exchangeIndex + 1}`,
          role: "assistant",
          text: [
            `Profiling note ${exchangeIndex + 1}:`,
            "- Checked event dispatch and render cadence.",
            "- Compared selector interactions and thread switches.",
            "- Captured actionable optimization candidates.",
          ].join("\n"),
          createdAt: assistantCreatedAt,
          streaming: false,
        });
      }

      threads.push({
        id: threadId,
        projectId: project.id,
        title: `${project.name} perf thread ${threadIndex + 1}`,
        model: "gpt-5-codex",
        terminalOpen: false,
        messages,
        createdAt: threadCreatedAt,
        lastVisitedAt: new Date(now - threadOrdinal * 2_000).toISOString(),
      });
      threadOrdinal += 1;
    }
  }

  for (const project of projects) {
    threads.push(buildLargePerfThread(project, now));
  }

  return {
    version: 7,
    runtimeMode: "approval-required",
    projects,
    threads,
    activeThreadId: threads[0]?.id ?? null,
  };
}

async function seedRendererState(
  window: BrowserWindow,
  state: unknown,
): Promise<void> {
  const script = `
    (() => {
      const key = "t3code:renderer-state:v7";
      localStorage.setItem(key, JSON.stringify(${JSON.stringify(state)}));
      window.location.reload();
    })();
  `;
  await window.webContents.executeJavaScript(script, true);
}

async function readRendererPersistedThreadCount(window: BrowserWindow): Promise<number> {
  const script = `
    (() => {
      const key = "t3code:renderer-state:v7";
      const raw = localStorage.getItem(key);
      let threads = 0;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          threads = Array.isArray(parsed?.threads) ? parsed.threads.length : 0;
        } catch {
          threads = -1;
        }
      }
      return threads;
    })();
  `;
  return window.webContents.executeJavaScript(script, true);
}

async function runRendererPerfInteractions(
  window: BrowserWindow,
  benchmarkThreadIds: string[],
): Promise<RendererPerfInteractions> {
  const script = `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const must = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitFor = async (predicate, timeoutMs, message) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (predicate()) return;
          await nextFrame();
        }
        throw new Error(message);
      };

      const clickElement = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        node.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        node.click();
        return true;
      };
      const getThreadButtons = () =>
        Array.from(document.querySelectorAll("[data-perf-thread-id]")).filter(
          (node) => node instanceof HTMLElement,
        );
      const getPersistedStateStats = () => {
        const key = "t3code:renderer-state:v7";
        const raw = localStorage.getItem(key);
        if (!raw) {
          return { present: false, projects: 0, threads: 0 };
        }
        try {
          const parsed = JSON.parse(raw);
          const projects = Array.isArray(parsed?.projects) ? parsed.projects.length : 0;
          const threads = Array.isArray(parsed?.threads) ? parsed.threads.length : 0;
          return { present: true, projects, threads };
        } catch {
          return { present: true, projects: -1, threads: -1 };
        }
      };
      const getThreadListDiagnostics = () => ({
        url: window.location.href,
        readyState: document.readyState,
        threadButtonCount: getThreadButtons().length,
        sidebarButtonCount: document.querySelectorAll("nav button").length,
        noProjectsVisible:
          document.body.textContent?.toLowerCase().includes("no projects yet") ?? false,
        connectingVisible:
          document.body.textContent?.toLowerCase().includes("connecting to t3 code server") ?? false,
        persistedState: getPersistedStateStats(),
      });
      let threadButtons = [];
      let renderedThreadIds = [];
      try {
        await waitFor(
          () => getThreadButtons().length >= 1,
          15_000,
          "Expected seeded thread rows to be rendered.",
        );
        threadButtons = getThreadButtons();
        renderedThreadIds = threadButtons
          .map((node) => node.getAttribute("data-perf-thread-id"))
          .filter((value) => typeof value === "string" && value.length > 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[desktop-perf] thread list unavailable; continuing", {
          message,
          diagnostics: getThreadListDiagnostics(),
        });
      }
      const getActiveThreadId = () => {
        const scroller = document.querySelector("[data-perf-messages-scroll]");
        if (!(scroller instanceof HTMLElement)) return null;
        const value = scroller.getAttribute("data-perf-active-thread-id");
        return typeof value === "string" && value.length > 0 ? value : null;
      };
      const waitForActiveThread = async (threadId) => {
        await waitFor(
          () => getActiveThreadId() === threadId,
          15_000,
          "Timed out waiting for thread activation " + threadId,
        );
      };

      const measureThreadRender = async (threadId) => {
        const selector = '[data-perf-thread-id="' + threadId + '"]';
        const targetButton = document.querySelector(selector);
        must(targetButton instanceof HTMLElement, "Thread button missing for " + threadId);
        const start = performance.now();
        clickElement(targetButton);
        await waitForActiveThread(threadId);
        await nextFrame();
        await nextFrame();
        const scroller = document.querySelector("[data-perf-messages-scroll]");
        const messageCountRaw =
          scroller instanceof HTMLElement ? scroller.getAttribute("data-perf-message-count") : null;
        const messageCount =
          messageCountRaw && /^\\d+$/.test(messageCountRaw) ? Number(messageCountRaw) : 0;
        return {
          threadId,
          messageCount,
          renderMs: Number((performance.now() - start).toFixed(2)),
        };
      };
      const median = (values) => {
        if (!Array.isArray(values) || values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
          return Number((((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2).toFixed(2));
        }
        return Number((sorted[middle] ?? 0).toFixed(2));
      };

      const runBenchmarkThreadSweep = ${RUN_BENCHMARK_THREAD_SWEEP};
      const preferredThreadIds = ${JSON.stringify(benchmarkThreadIds)}.filter(
        (value) => typeof value === "string" && value.length > 0,
      );
      const benchmarkThreadIds = runBenchmarkThreadSweep
        ? preferredThreadIds.filter((threadId) => renderedThreadIds.includes(threadId))
        : [];
      if (runBenchmarkThreadSweep && benchmarkThreadIds.length === 0) {
        benchmarkThreadIds.push(...renderedThreadIds.slice(0, ${BENCHMARK_THREAD_COUNT}));
      }

      const ensureThreadSwitchTarget = async (threadId) => {
        if (getActiveThreadId() !== threadId) {
          return;
        }
        const fallbackThreadId = renderedThreadIds.find((id) => id !== threadId);
        if (!fallbackThreadId) return;
        const fallbackButton = document.querySelector('[data-perf-thread-id="' + fallbackThreadId + '"]');
        if (!(fallbackButton instanceof HTMLElement)) return;
        clickElement(fallbackButton);
        await waitForActiveThread(fallbackThreadId);
        await nextFrame();
      };

      const firstPassByThreadId = new Map();
      const followUpSamplesByThreadId = new Map();
      if (runBenchmarkThreadSweep) {
        for (const threadId of benchmarkThreadIds) {
          await ensureThreadSwitchTarget(threadId);
          firstPassByThreadId.set(threadId, await measureThreadRender(threadId));
        }

        for (const threadId of benchmarkThreadIds) {
          followUpSamplesByThreadId.set(threadId, []);
        }
        const followUpPassCount = ${BENCHMARK_FOLLOW_UP_PASS_COUNT};
        for (let passIndex = 0; passIndex < followUpPassCount; passIndex += 1) {
          for (const threadId of benchmarkThreadIds) {
            await ensureThreadSwitchTarget(threadId);
            const sample = await measureThreadRender(threadId);
            const samples = followUpSamplesByThreadId.get(threadId);
            if (Array.isArray(samples)) {
              samples.push(sample.renderMs);
            } else {
              followUpSamplesByThreadId.set(threadId, [sample.renderMs]);
            }
          }
        }
      }

      const largeThreadRenderStats = benchmarkThreadIds.map((threadId) => {
        const first = firstPassByThreadId.get(threadId);
        const followUpSamples = followUpSamplesByThreadId.get(threadId);
        const messageCount = first?.messageCount ?? 0;
        const firstRenderMs = first?.renderMs ?? 0;
        const followUpValues =
          Array.isArray(followUpSamples) && followUpSamples.length > 0
            ? followUpSamples
            : [firstRenderMs];
        const followUpMinMs = Number(Math.min(...followUpValues).toFixed(2));
        const followUpMaxMs = Number(Math.max(...followUpValues).toFixed(2));
        const followUpRenderMs = median(followUpValues);
        const deltaMs = Number((followUpRenderMs - firstRenderMs).toFixed(2));
        const deltaPct =
          firstRenderMs > 0 ? Number((((followUpRenderMs - firstRenderMs) / firstRenderMs) * 100).toFixed(1)) : 0;
        return {
          threadId,
          messageCount,
          firstRenderMs,
          followUpRenderMs,
          followUpMinMs,
          followUpMaxMs,
          followUpSampleCount: Array.isArray(followUpSamples) ? followUpSamples.length : 0,
          deltaMs,
          deltaPct,
        };
      });

      const runOptionalRendererInteractions = ${RUN_OPTIONAL_RENDERER_INTERACTIONS};
      const clickCount = Math.min(1, threadButtons.length);
      for (let index = 0; index < clickCount; index += 1) {
        clickElement(threadButtons[index]);
        await sleep(80);
      }

      const scroller = document.querySelector("[data-perf-messages-scroll]");
      if (runOptionalRendererInteractions && scroller instanceof HTMLElement) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
        await sleep(60);
        scroller.scrollTo({ top: 0, behavior: "instant" });
        await sleep(60);
      }

      const getComposerTextarea = () => {
        const direct = document.querySelector("[data-perf-composer-input]");
        if (direct instanceof HTMLTextAreaElement) return direct;
        const fallback = document.querySelector("form textarea");
        if (fallback instanceof HTMLTextAreaElement) return fallback;
        return null;
      };
      try {
        await waitFor(
          () => getComposerTextarea() instanceof HTMLTextAreaElement,
          15_000,
          "Composer textarea missing.",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          "Composer textarea missing. diagnostics=" +
            JSON.stringify({
              ...getThreadListDiagnostics(),
              hasMessagesScroll:
                document.querySelector("[data-perf-messages-scroll]") instanceof HTMLElement,
              activeThreadId: getActiveThreadId(),
            }) +
            "; cause=" +
            message,
        );
      }
      const textarea = getComposerTextarea();
      must(textarea instanceof HTMLTextAreaElement, "Composer textarea missing.");
      textarea.focus();

      const valueDescriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      );
      const setValue = valueDescriptor?.set;
      must(typeof setValue === "function", "Textarea value setter unavailable.");
      const inputText = runOptionalRendererInteractions ? "Perf." : ".";

      for (const character of inputText) {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", { key: character, bubbles: true, cancelable: true }),
        );
        setValue.call(textarea, textarea.value + character);
        textarea.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        textarea.dispatchEvent(
          new KeyboardEvent("keyup", { key: character, bubbles: true, cancelable: true }),
        );
        await sleep(8);
      }

      const selectOption = async (triggerSelector, optionSelector, label) => {
        const trigger = document.querySelector(triggerSelector);
        if (!(trigger instanceof HTMLElement)) {
          console.warn("[desktop-perf] selector trigger not found", { label, triggerSelector });
          return null;
        }
        clickElement(trigger);
        await sleep(130);

        const options = Array.from(document.querySelectorAll(optionSelector)).filter(
          (node) => node instanceof HTMLElement,
        );
        if (options.length === 0) {
          console.warn("[desktop-perf] selector options not found", { label, optionSelector });
          return null;
        }
        const preferred = options[1] ?? options[0];
        clickElement(preferred);
        await sleep(130);
        return preferred.textContent?.trim() ?? null;
      };

      let selectedModel = null;
      if (runOptionalRendererInteractions) {
        selectedModel = await selectOption(
          "[data-perf-model-trigger]",
          "[data-perf-model-option]",
          "Model",
        );
        await selectOption(
          "[data-perf-reasoning-trigger]",
          "[data-perf-reasoning-option]",
          "Reasoning",
        );

        const diffToggle = document.querySelector("[data-perf-diff-toggle]");
        if (diffToggle instanceof HTMLElement) {
          clickElement(diffToggle);
          await sleep(70);
          clickElement(diffToggle);
          await sleep(70);
        }

        const runtimeToggle = document.querySelector("[data-perf-runtime-toggle]");
        if (runtimeToggle instanceof HTMLElement) {
          clickElement(runtimeToggle);
          await sleep(100);
        }
      }

      return {
        threadClicks: clickCount,
        typedChars: inputText.length,
        selectedModel,
        largeThreadRenderStats,
        benchmarkThreadIds,
      };
    })();
  `;

  return window.webContents.executeJavaScript(script, true);
}

async function evaluateRenderer<T>(window: BrowserWindow, script: string): Promise<T> {
  return window.webContents.executeJavaScript(script, true) as Promise<T>;
}

async function waitForRendererCondition(
  window: BrowserWindow,
  script: string,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await evaluateRenderer<boolean>(window, script);
    if (matched) return;
    await delay(50);
  }
  throw new Error(message);
}

function sendShortcutKey(
  webContents: WebContents,
  keyCode: string,
  modifier: TerminalPerfInteractions["modifierUsed"],
): void {
  webContents.sendInputEvent({
    type: "keyDown",
    keyCode,
    modifiers: [modifier],
  });
  webContents.sendInputEvent({
    type: "keyUp",
    keyCode,
    modifiers: [modifier],
  });
}

async function sendTextInput(webContents: WebContents, text: string): Promise<void> {
  for (const character of text) {
    webContents.sendInputEvent({
      type: "char",
      keyCode: character,
    });
    await delay(4);
  }
}

async function pressEnter(webContents: WebContents): Promise<void> {
  webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "Enter",
  });
  webContents.sendInputEvent({
    type: "keyUp",
    keyCode: "Enter",
  });
  await delay(20);
}

async function focusActiveTerminalInput(window: BrowserWindow): Promise<void> {
  await waitForRendererCondition(
    window,
    `(() => {
      const inputs = Array.from(
        document.querySelectorAll(".thread-terminal-drawer .xterm-helper-textarea"),
      );
      const target = inputs[inputs.length - 1];
      if (!(target instanceof HTMLTextAreaElement)) return false;
      target.focus();
      return document.activeElement === target;
    })()`,
    "Active terminal input is not focusable.",
    15_000,
  );
}

async function runTerminalPerfInteractions(
  window: BrowserWindow,
): Promise<TerminalPerfInteractions> {
  window.focus();
  window.webContents.focus();

  const modifier = await evaluateRenderer<TerminalPerfInteractions["modifierUsed"]>(
    window,
    `navigator.platform.toLowerCase().includes("mac") ? "meta" : "control"`,
  );
  const terminalDrawerSelector = ".thread-terminal-drawer";

  sendShortcutKey(window.webContents, "J", modifier);
  try {
    await waitForRendererCondition(
      window,
      `document.querySelector(${JSON.stringify(terminalDrawerSelector)}) instanceof HTMLElement`,
      "Terminal drawer did not open after shortcut.",
      15_000,
    );
  } catch (error) {
    const diagnostics = await evaluateRenderer(window, `(() => ({
      url: window.location.href,
      readyState: document.readyState,
      hasDrawer: document.querySelector(${JSON.stringify(terminalDrawerSelector)}) instanceof HTMLElement,
      terminalButtonCount: document.querySelectorAll("[data-perf-terminal-toggle]").length,
      activeElementTag: document.activeElement ? document.activeElement.tagName : null,
      bodyHasConnectText:
        document.body.textContent?.toLowerCase().includes("connecting to t3 code server") ?? false,
    }))()`);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Terminal drawer did not open after shortcut. diagnostics=${JSON.stringify(diagnostics)}; cause=${message}`,
      {
        cause: error,
      },
    );
  }

  await focusActiveTerminalInput(window);

  let splitCount = 0;
  for (let splitIndex = 0; splitIndex < 2; splitIndex += 1) {
    await focusActiveTerminalInput(window);
    sendShortcutKey(window.webContents, "D", modifier);
    try {
      await waitForRendererCondition(
        window,
        `document.querySelectorAll(".thread-terminal-drawer .xterm-helper-textarea").length >= ${
          splitIndex + 2
        }`,
        "Terminal split did not appear.",
        15_000,
      );
      splitCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[desktop-perf] terminal split attempt ${splitIndex + 1} failed: ${message}`);
      break;
    }
  }

  const commandMarker = `perfterm${Date.now().toString(36)}`;
  const markerFilePath = path.join(os.tmpdir(), `t3code-desktop-perf-${commandMarker}`);
  try {
    fs.rmSync(markerFilePath, { force: true });
  } catch {
    // best effort cleanup for stale marker file
  }

  await focusActiveTerminalInput(window);
  await sendTextInput(window.webContents, `echo ${commandMarker}`);
  await pressEnter(window.webContents);
  await delay(120);

  await focusActiveTerminalInput(window);
  await sendTextInput(window.webContents, `touch ${markerFilePath}`);
  await pressEnter(window.webContents);

  const fileWaitDeadline = Date.now() + 20_000;
  let commandFileTouched = false;
  while (Date.now() < fileWaitDeadline) {
    if (fs.existsSync(markerFilePath)) {
      commandFileTouched = true;
      break;
    }
    await delay(100);
  }
  if (!commandFileTouched) {
    throw new Error(`Terminal command side effect file not observed at ${markerFilePath}.`);
  }

  let commandEchoObserved = false;
  try {
    await waitForRendererCondition(
      window,
      `(() => {
        const marker = ${JSON.stringify(commandMarker)};
        const drawer = document.querySelector(${JSON.stringify(terminalDrawerSelector)});
        if (!(drawer instanceof HTMLElement)) return false;
        const rawText = [
          drawer.textContent ?? "",
          ...Array.from(
            drawer.querySelectorAll(
              ".xterm-accessibility, .xterm-accessibility-tree, .xterm-helper-textarea",
            ),
          ).map((node) => node.textContent ?? ""),
        ].join(" ");
        return rawText.toLowerCase().includes(marker.toLowerCase());
      })()`,
      "Terminal command output marker was not found in terminal DOM.",
      5_000,
    );
    commandEchoObserved = true;
  } catch {
    commandEchoObserved = false;
  }

  try {
    fs.rmSync(markerFilePath, { force: true });
  } catch {
    // best effort cleanup after verification
  }

  return {
    openedByShortcut: true,
    splitCount,
    commandMarker,
    commandEchoObserved,
    commandFileTouched,
    modifierUsed: modifier,
  };
}

export async function runDesktopPerfAutomation(window: BrowserWindow): Promise<void> {
  if (!PERF_AUTOMATION_ENABLED) return;
  console.log("[desktop-perf] automation mode enabled");
  if (PERF_DONE_OUT_PATH.length > 0) {
    console.log(`[desktop-perf] done marker path: ${PERF_DONE_OUT_PATH}`);
  }
  console.log(`[desktop-perf] trace path: ${PERF_TRACE_OUT_PATH}`);
  console.log(
    "[desktop-perf] interaction toggles:",
    JSON.stringify({
      terminal: RUN_TERMINAL_INTERACTIONS,
      optionalRenderer: RUN_OPTIONAL_RENDERER_INTERACTIONS,
      benchmarkSweep: RUN_BENCHMARK_THREAD_SWEEP,
      benchmarkFollowUpPasses: BENCHMARK_FOLLOW_UP_PASS_COUNT,
    }),
  );

  if (PERF_TRACE_OUT_PATH.length === 0) {
    const error = new Error("T3CODE_DESKTOP_PERF_TRACE_OUT is required for perf automation.");
    console.error("[desktop-perf] " + error.message);
    if (PERF_DONE_OUT_PATH.length > 0) {
      fs.mkdirSync(path.dirname(PERF_DONE_OUT_PATH), { recursive: true });
      fs.writeFileSync(
        PERF_DONE_OUT_PATH,
        JSON.stringify(
          {
            status: "error",
            error: error.message,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  const traceConfig = {
    included_categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "blink.user_timing",
      "v8",
      "disabled-by-default-v8.cpu_profiler",
      "disabled-by-default-v8.gc",
    ],
    record_mode: "record-until-full",
  };

  let tracePath = PERF_TRACE_OUT_PATH;
  let isTraceRecording = false;
  const startedAt = Date.now();
  let seed: ResolvedPerfSeed | null = null;
  try {
    seed = resolvePerfSeed();
    const seedLabel =
      seed.source === "file" ? `file (${seed.resolvedPath ?? "unknown"})` : seed.source;
    const benchmarkThreadLabel =
      seed.benchmarkThreads.length > 0
        ? seed.benchmarkThreads
            .slice(0, 5)
            .map((thread) => `${thread.id} (${toTitlePreview(thread.title)})`)
            .join(", ")
        : "none";
    console.log(`[desktop-perf] seed source: ${seedLabel}`);
    console.log(`[desktop-perf] benchmark thread count: ${seed.benchmarkThreads.length}`);
    console.log(`[desktop-perf] benchmark thread preview: ${benchmarkThreadLabel}`);

    console.log("[desktop-perf] waiting for initial load");
    await waitForDidFinishLoad(window.webContents, {
      timeoutMs: 60_000,
      label: "initial load",
    });
    console.log("[desktop-perf] seeding renderer state");
    await seedRendererState(window, seed.state);
    console.log("[desktop-perf] waiting for reload");
    await waitForDidFinishLoad(window.webContents, {
      timeoutMs: 60_000,
      label: "post-seed reload",
    });
    let postSeedThreadCount = await readRendererPersistedThreadCount(window);
    if (postSeedThreadCount <= 0) {
      console.warn("[desktop-perf] post-seed state had no threads; retrying seed on current origin");
      await seedRendererState(window, seed.state);
      await waitForDidFinishLoad(window.webContents, {
        timeoutMs: 60_000,
        label: "post-seed retry reload",
      });
      postSeedThreadCount = await readRendererPersistedThreadCount(window);
      if (postSeedThreadCount <= 0) {
        console.warn("[desktop-perf] post-seed retry still has no threads");
      }
    }
    await delay(300);

    fs.mkdirSync(path.dirname(PERF_TRACE_OUT_PATH), { recursive: true });
    console.log("[desktop-perf] starting trace recording");
    await contentTracing.startRecording(traceConfig);
    isTraceRecording = true;
    console.log("[desktop-perf] running scripted interactions");
    let rendererInteractions: RendererPerfInteractions = {
      threadClicks: 0,
      typedChars: 0,
      selectedModel: null,
      largeThreadRenderStats: [],
      benchmarkThreadIds: [],
    };
    try {
      rendererInteractions = await runRendererPerfInteractions(
        window,
        seed.benchmarkThreads.map((thread) => thread.id),
      );
    } catch (rendererError) {
      const message = rendererError instanceof Error ? rendererError.message : String(rendererError);
      console.warn("[desktop-perf] renderer scripted interactions failed; continuing:", message);
    }
    let terminalInteractions: TerminalPerfInteractions = {
      openedByShortcut: false,
      splitCount: 0,
      commandMarker: "",
      commandEchoObserved: false,
      commandFileTouched: false,
      modifierUsed: process.platform === "darwin" ? "meta" : "control",
    };
    if (RUN_TERMINAL_INTERACTIONS) {
      console.log("[desktop-perf] running terminal shortcut interactions");
      try {
        terminalInteractions = await runTerminalPerfInteractions(window);
      } catch (terminalError) {
        const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
        console.warn("[desktop-perf] terminal scripted interactions failed; continuing:", message);
      }
    } else {
      console.log("[desktop-perf] terminal shortcut interactions disabled for this run");
    }
    const interactions = {
      ...rendererInteractions,
      terminal: terminalInteractions,
    };
    const titleByThreadId = new Map(
      seed.benchmarkThreads.map((thread) => [thread.id, toTitlePreview(thread.title)]),
    );
    const interactionsWithTitles = {
      ...interactions,
      // oxlint-disable-next-line oxc/no-map-spread
      largeThreadRenderStats: interactions.largeThreadRenderStats.map((stat) => ({
        ...stat,
        threadTitleShort:
          titleByThreadId.get(stat.threadId) ??
          stat.threadId.slice(0, BENCHMARK_TITLE_PREVIEW_LENGTH),
      })),
    };
    await delay(300);
    console.log("[desktop-perf] stopping trace recording");
    tracePath = await withTimeout(
      contentTracing.stopRecording(PERF_TRACE_OUT_PATH),
      15_000,
      "trace recording to stop",
    );
    isTraceRecording = false;
    const completedAt = Date.now();

    console.log(`[desktop-perf] trace recorded at ${tracePath}`);
    if (PERF_DONE_OUT_PATH.length > 0) {
      fs.mkdirSync(path.dirname(PERF_DONE_OUT_PATH), { recursive: true });
      fs.writeFileSync(
        PERF_DONE_OUT_PATH,
        JSON.stringify(
          {
            status: "ok",
            tracePath,
            interactions: interactionsWithTitles,
            seed: {
              source: seed.source,
              path: seed.resolvedPath,
              projectCount: seed.projectCount,
              threadCount: seed.threadCount,
              benchmarkThreadCount: seed.benchmarkThreads.length,
            },
            config: {
              runTerminalInteractions: RUN_TERMINAL_INTERACTIONS,
              runOptionalRendererInteractions: RUN_OPTIONAL_RENDERER_INTERACTIONS,
              runBenchmarkThreadSweep: RUN_BENCHMARK_THREAD_SWEEP,
              benchmarkFollowUpPassCount: BENCHMARK_FOLLOW_UP_PASS_COUNT,
            },
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
            durationMs: completedAt - startedAt,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    if (isTraceRecording) {
      try {
        tracePath = await withTimeout(
          contentTracing.stopRecording(PERF_TRACE_OUT_PATH),
          15_000,
          "trace recording to stop after failure",
        );
      } catch (stopError) {
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
        console.error("[desktop-perf] failed to stop trace recording:", stopMessage);
      } finally {
        isTraceRecording = false;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[desktop-perf] automation failed:", message);
    if (PERF_DONE_OUT_PATH.length > 0) {
      fs.mkdirSync(path.dirname(PERF_DONE_OUT_PATH), { recursive: true });
      fs.writeFileSync(
        PERF_DONE_OUT_PATH,
        JSON.stringify(
          {
            status: "error",
            error: message,
            tracePath,
            seed:
              seed === null
                ? undefined
                : {
                    source: seed.source,
                    path: seed.resolvedPath,
                    projectCount: seed.projectCount,
                    threadCount: seed.threadCount,
                    benchmarkThreadCount: seed.benchmarkThreads.length,
                  },
            config: {
              runTerminalInteractions: RUN_TERMINAL_INTERACTIONS,
              runOptionalRendererInteractions: RUN_OPTIONAL_RENDERER_INTERACTIONS,
              runBenchmarkThreadSweep: RUN_BENCHMARK_THREAD_SWEEP,
              benchmarkFollowUpPassCount: BENCHMARK_FOLLOW_UP_PASS_COUNT,
            },
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    }
  }
}
