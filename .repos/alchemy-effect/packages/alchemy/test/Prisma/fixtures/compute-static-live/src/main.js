import "./style.css";

console.log("alchemy static asset");

const counter = document.querySelector("#counter");
let count = 0;
counter.addEventListener("click", () => {
  count += 1;
  counter.textContent = `Count: ${count}`;
});
document.querySelector("#route").textContent = window.location.pathname;
