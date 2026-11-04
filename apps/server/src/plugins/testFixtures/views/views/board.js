// Runs in the isolated view frame after the host bootstrap defines `t3View`.
const status = document.createElement("p");
document.body.append(status);
status.textContent = "Connecting…";
t3View.ready.then(async (view) => {
  status.textContent = `${view.title} is connected.`;
  const answer = await t3View.call("echo", { from: view.viewId });
  status.textContent = `${view.title} received ${JSON.stringify(answer)}`;
});
