// Shared local-Ollama wiring for the examples. The dummy bearer works
// around @corbits/system-one fail-closing on keyless `custom` endpoints.
export const LOCAL_JEV = {
  endpoint: {
    kind: "custom" as const,
    url: "http://localhost:11434/v1/systemone",
    model: "clef-flash:9b",
  },
  apiKey: "ollama-local",
  timeoutMs: 180_000,
};

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
