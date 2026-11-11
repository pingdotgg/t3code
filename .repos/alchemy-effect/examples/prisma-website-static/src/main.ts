import "./style.css";

let count = 0;
const counter = document.querySelector<HTMLButtonElement>("#counter")!;
counter.addEventListener("click", () => {
  counter.textContent = `count: ${++count}`;
});

const greeting = document.querySelector<HTMLElement>("#greeting")!;
document.querySelector("#load-greeting")!.addEventListener("click", async () => {
  try {
    const response = await fetch("/example.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { greeting: string };
    greeting.textContent = body.greeting;
  } catch {
    greeting.textContent = "Could not load the greeting. Try again.";
  }
});
