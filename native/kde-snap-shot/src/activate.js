// targetPid, targetTitle, and reply are supplied by the one-shot native helper.
let finished = false;
let target;
const deadline = new QTimer();
deadline.singleShot = true;
deadline.interval = 4000;
function finish(activated) {
  if (finished) return;
  finished = true;
  deadline.stop();
  reply({ activated });
}
function confirm() {
  if (target && workspace.activeWindow === target) finish(true);
}
function activate() {
  if (finished) return;
  const matches = workspace
    .windowList()
    .filter((w) => w.pid === targetPid && w.caption === targetTitle);
  if (matches.length > 1) return finish(false);
  if (matches.length !== 1) return;
  target = matches[0];
  target.minimized = false;
  workspace.activeWindow = target;
  confirm();
}
function watch(window) {
  if (window.pid === targetPid) window.captionChanged.connect(activate);
}
workspace.windowAdded.connect((window) => {
  watch(window);
  activate();
});
workspace.windowActivated.connect(confirm);
workspace.windowList().forEach(watch);
deadline.timeout.connect(() => finish(false));
deadline.start();
activate();
