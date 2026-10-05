import "./style.css";

const button = document.querySelector<HTMLButtonElement>("#refresh")!;
const result = document.querySelector<HTMLParagraphElement>("#result")!;

button.addEventListener("click", async () => {
  button.disabled = true;
  result.textContent = "Querying Postgres…";
  try {
    const response = await fetch(`${import.meta.env.VITE_API_URL}/api/time`);
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const data: { time: string } = await response.json();
    result.textContent = `Database time: ${data.time}`;
  } catch {
    result.textContent = "Could not read the database. Please try again.";
  } finally {
    button.disabled = false;
  }
});
