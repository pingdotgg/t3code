// Browsers may not support `using`, so the client build should lower it
const disposed: string[] = [];
{
  using _resource = {
    [Symbol.dispose]() {
      disposed.push("resource");
    },
  };
}
const heading = document.querySelector("h1");
if (heading) {
  heading.textContent = disposed.join(",");
}
