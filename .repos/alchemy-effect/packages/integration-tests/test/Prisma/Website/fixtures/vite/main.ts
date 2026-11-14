export {};

let count = 0;
const button = document.querySelector<HTMLButtonElement>("#counter")!;
button.addEventListener("click", () => {
  button.textContent = `Count: ${++count}`;
});
document.querySelector("#message")!.textContent = "first revision";
