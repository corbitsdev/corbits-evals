// Shared local-Ollama wiring for the examples. The dummy key works
// around @corbits/system-one fail-closing on keyless custom endpoints.
import { jev } from "../src/index.js";

export const localJev = jev({
  endpoint: "http://localhost:11434/v1/systemone",
  model: "clef-flash:9b",
  apiKey: "ollama-local",
  timeout: "180s",
});

export async function ollamaGenerate(model: string, prompt: string): Promise<string> {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`ollama generate HTTP ${res.status}`);
  const data = (await res.json()) as { response?: unknown };
  if (typeof data.response !== "string") throw new Error("ollama generate: no response text");
  return data.response;
}
