// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Host-side device automation.

import * as NodePath from "node:path";

import {
  check,
  type Check,
  describeRect,
  findLabel,
  keyboardRect,
  layoutChecks,
  type Rect,
  type Snapshot,
  type SnapshotNode,
  tabBarRect,
} from "./checks.ts";
import { BUNDLE_ID, delay, type Device } from "./device.ts";
import { lagCheck } from "./video.ts";

export interface StepResult {
  readonly name: string;
  readonly checks: ReadonlyArray<Check>;
  readonly screenshot?: string;
  readonly video?: string;
  readonly lagFrame?: string;
}

// Threads of the fixture's first environment (scripts/mobile-showcase-environment.ts).
const THREAD_TITLE =
  /Make remote coding feel local|Put the command center in your pocket|Tune the handoff haptics/;
const BACK = /^(Back|Navigate up|Go back)$/i;

const backButton = (snapshot: Snapshot) =>
  snapshot.nodes.find((node) => node.identifier === "BackButton") ?? findLabel(snapshot, BACK);
const composer = (snapshot: Snapshot) =>
  snapshot.nodes
    .filter(
      (node) =>
        (node.kind === "text-field" || node.kind === "text-view" || node.editable === true) &&
        node.rect &&
        node.rect.y < snapshot.viewport.height &&
        node.bundleId !== "com.android.systemui",
    )
    .toSorted((a, b) => b.rect!.y - a.rect!.y)[0];
const threadRow = (snapshot: Snapshot) => findLabel(snapshot, THREAD_TITLE);

const inside = (rect: Rect | undefined, snapshot: Snapshot) =>
  rect !== undefined &&
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.width <= snapshot.viewport.width + 1 &&
  rect.y + rect.height <= snapshot.viewport.height + 1;

const topBand = (snapshot: Snapshot): Rect => ({
  x: 0,
  y: 0,
  width: snapshot.viewport.width,
  height: snapshot.viewport.height * 0.12,
});

/**
 * Walks one device through the app like a person would: thread list, a thread, scrolling,
 * typing, back, settings, then the pose's own change (rotation or fold). Every screen gets
 * the generic layout checks plus what that screen must show. Steps land in `steps` as they
 * finish, so a journey that stops early still reports what it saw.
 */
export async function runJourney(
  device: Device,
  directory: string,
  pair: () => Promise<string>,
  steps: StepResult[],
): Promise<void> {
  const phone = device.pose.form === "phone";
  const tap = async (node: SnapshotNode | undefined, label: string) => {
    if (!node?.ref || !node.rect) throw new Error(`no ${label} to tap`);
    // agent-device refuses refs it considers covered, such as on the unfolded Duo's inner
    // display; the element's centre still takes the tap.
    await device
      .agent(["press", `@${node.ref}`])
      .catch(() =>
        device.agent([
          "press",
          String(Math.round(node.rect!.x + node.rect!.width / 2)),
          String(Math.round(node.rect!.y + node.rect!.height / 2)),
        ]),
      );
  };

  /** Screenshot and check the settled screen, and record it as a step. */
  const capture = async (
    name: string,
    snapshot: Snapshot,
    expectations: ReadonlyArray<Check> = [],
    extra: Partial<StepResult> = {},
  ) => {
    const screenshot = NodePath.join(directory, `${steps.length + 1}-${name}.png`);
    await device.screenshot(screenshot);
    const step = {
      name,
      checks: [...layoutChecks(snapshot, BUNDLE_ID), ...expectations],
      screenshot,
      ...extra,
    };
    steps.push(step);
    return step;
  };

  // The app ignores the pairing link until its JS has loaded and shown the workspace. An
  // error dialog on the way is a finding: record it, dismiss it, and keep going.
  const loaded = (snapshot: Snapshot) =>
    findLabel(snapshot, /Add environment|New (chat|thread)/i) !== undefined;
  const errorDialog = (snapshot: Snapshot) =>
    findLabel(snapshot, /^(Dismiss|OK|Close)$/) !== undefined
      ? findLabel(snapshot, /^Could not|failed|went wrong/i)
      : undefined;
  for (let dialogs = 0; ; dialogs++) {
    const launch = await device.waitFor(
      (snapshot) => loaded(snapshot) || errorDialog(snapshot) !== undefined,
      "the app to load",
      180_000,
    );
    const dialog = errorDialog(launch);
    if (!dialog || dialogs >= 3) break;
    await capture("launch error", launch, [
      check("no error dialog on launch", false, dialog.label ?? "error dialog"),
    ]);
    await device.agent(["press", `label="${findLabel(launch, /^(Dismiss|OK|Close)$/)!.label}"`]);
    await delay(1_000);
  }
  let threads: Snapshot | null = null;
  for (let attempt = 1; attempt <= 2 && !threads; attempt++) {
    const pairing = new URLSearchParams({ pairingUrl: await pair(), autoConnect: "1" });
    await device.openUrl(`t3code-dev://connections/new?${pairing}`);
    threads = await device
      .waitFor((snapshot) => threadRow(snapshot) !== undefined, "the paired thread list", 60_000)
      .catch(() => null);
  }
  if (!threads) throw new Error("the app did not show the fixture threads after pairing");
  // Rotated only once the app is up: a rotation during launch is lost.
  await delay(1_000);
  threads = await device.orient(device.pose.landscape ? "landscape" : "portrait");
  const tabs = tabBarRect(threads);
  // A bottom tab bar gives way to a pushed thread; the folded Duo's side rail stays put.
  const bottomTabs = phone && tabs && tabs.width > tabs.height ? tabs : undefined;
  const wide = threads.viewport.width > threads.viewport.height;
  await capture("threads", threads, [
    check(
      device.pose.landscape ? "in landscape" : "in portrait",
      wide === Boolean(device.pose.landscape),
      `${Math.round(threads.viewport.width)}×${Math.round(threads.viewport.height)}`,
    ),
    check("thread list visible", threadRow(threads) !== undefined, "fixture threads"),
    ...(phone ? [check("tab bar visible", inside(tabs, threads), describeRect(tabs))] : []),
  ]);

  const opening = await device.recorded(directory, "open-thread", () =>
    tap(threadRow(threads!), "thread row"),
  );
  const thread = await device.waitFor(
    (snapshot) => composer(snapshot) !== undefined && threadRow(snapshot) !== undefined,
    "the thread screen",
  );
  const threadShot = NodePath.join(directory, `${steps.length + 1}-thread.png`);
  await device.screenshot(threadShot);
  const openLag = bottomTabs
    ? await lagCheck(
        "no tabs over the entering thread (video)",
        {
          video: opening,
          nav: topBand(threads),
          chrome: bottomTabs,
          viewportWidth: threads.viewport.width,
        },
        NodePath.join(directory, "open-thread-lag.png"),
      )
    : null;
  steps.push({
    name: "thread",
    screenshot: threadShot,
    video: opening,
    ...(openLag?.frame ? { lagFrame: openLag.frame } : {}),
    checks: [
      ...layoutChecks(thread, BUNDLE_ID),
      check(
        "composer inside the screen",
        inside(composer(thread)?.rect, thread),
        describeRect(composer(thread)?.rect),
      ),
      ...(phone ? [check("back button visible", backButton(thread) !== undefined, "back")] : []),
      ...(bottomTabs
        ? [
            check(
              "tab bar hidden",
              tabBarRect(thread) === undefined,
              describeRect(tabBarRect(thread)),
            ),
          ]
        : []),
      ...(openLag ? [openLag.check] : []),
    ],
  });

  await device.agent(["scroll", "up"]).catch(() => undefined);
  await delay(800);
  await capture("scrolled up", await device.snapshot());
  await device.agent(["scroll", "down"]).catch(() => undefined);
  await delay(800);

  await tap(composer(await device.snapshot()), "composer");
  await device.agent(["type", "Checking the composer above the keyboard"]);
  await delay(1_200);
  const typing = await device.snapshot();
  await capture("typing", typing, [
    check(
      "composer visible while typing",
      inside(composer(typing)?.rect, typing),
      describeRect(composer(typing)?.rect),
    ),
    check(
      "composer above the keyboard",
      keyboardRect(typing) === undefined ||
        (composer(typing)?.rect?.y ?? Infinity) < keyboardRect(typing)!.y,
      `composer ${describeRect(composer(typing)?.rect)}, keyboard ${describeRect(keyboardRect(typing))}`,
    ),
  ]);
  await device.agent(["keyboard", "dismiss"]).catch(() => undefined);
  await delay(800);

  if (phone) {
    const back = await device.recorded(directory, "back", async () => {
      const current = await device.snapshot();
      const button = backButton(current);
      if (button) await tap(button, "back button");
      else await device.agent(["back"]);
    });
    const list = await device.waitFor(
      (snapshot) => backButton(snapshot) === undefined && threadRow(snapshot) !== undefined,
      "the thread list",
    );
    const listShot = NodePath.join(directory, `${steps.length + 1}-back.png`);
    await device.screenshot(listShot);
    const backLag = bottomTabs
      ? await lagCheck(
          "tabs return with the list (video)",
          {
            video: back,
            nav: topBand(list),
            chrome: bottomTabs,
            viewportWidth: list.viewport.width,
          },
          NodePath.join(directory, "back-lag.png"),
        )
      : null;
    steps.push({
      name: "back",
      screenshot: listShot,
      video: back,
      ...(backLag?.frame ? { lagFrame: backLag.frame } : {}),
      checks: [
        ...layoutChecks(list, BUNDLE_ID),
        check("tab bar back", inside(tabBarRect(list), list), describeRect(tabBarRect(list))),
        ...(backLag ? [backLag.check] : []),
      ],
    });
  }

  // The labelled tab is not always the hittable node; agent-device resolves the press.
  await device.agent(["press", 'label="Settings"']);
  await delay(1_500);
  await capture("settings", await device.snapshot());

  if (device.pose.form === "tablet" && !device.pose.fold) {
    await capture("rotated", await device.orient(device.pose.landscape ? "portrait" : "landscape"));
  }
  if (device.pose.fold) {
    await device.agent(["fold", device.pose.fold === "open" ? "closed" : "open"]);
    await delay(2_500);
    await capture(device.pose.fold === "open" ? "folded" : "unfolded", await device.snapshot());
  }
}
