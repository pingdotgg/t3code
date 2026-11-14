import { Counter } from "./Counter.js";

export default function Page() {
  return (
    <>
      <h1>My Vike app</h1>
      <p>This page is:</p>
      <ul>
        <li>Rendered to HTML.</li>
        <li>
          Interactive. <Counter />
        </li>
      </ul>
    </>
  );
}
