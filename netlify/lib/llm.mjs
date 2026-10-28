import { E, sleep } from "./db.mjs";

// Free options that work from Netlify: gemini (default, free tier), groq (free tier), openrouter (free models).
// Also supported: claude (paid API) and ollama (only if your Ollama server is reachable from the internet).
export function backend() {
  const b = E("LLM_BACKEND");
  if (b) return b;
  if (E("GEMINI_API_KEY")) return "gemini";
  if (E("GROQ_API_KEY")) return "groq";
  if (E("OPENROUTER_API_KEY")) return "openrouter";
  if (E("ANTHROPIC_API_KEY")) return "claude";
  if (E("OLLAMA_URL")) return "ollama";
  return "gemini";
}

async function post(url, headers, body) {
  let last;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    if (r.ok) return await r.json();
    last = `${r.status} ${(await r.text()).slice(0, 300)}`;
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * 2 ** i); continue; } // free tiers rate-limit; back off
    break;
  }
  throw new Error("LLM request failed: " + last);
}

export async function llm(system, user, maxTokens = 1200) {
  const b = backend();
  if (b === "gemini") {
    const key = E("GEMINI_API_KEY");
    if (!key) throw new Error("Set GEMINI_API_KEY (free at aistudio.google.com/apikey) in Netlify environment variables.");
    const model = E("GEMINI_MODEL", "gemini-2.5-flash");
    const gen = { maxOutputTokens: maxTokens + 1000 };
    if (/2\.5-flash/.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { "x-goog-api-key": key },
      { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: gen });
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  }
  if (b === "groq" || b === "openrouter") {
    const groq = b === "groq";
    const key = E(groq ? "GROQ_API_KEY" : "OPENROUTER_API_KEY");
    if (!key) throw new Error(`Set ${groq ? "GROQ_API_KEY" : "OPENROUTER_API_KEY"} in Netlify environment variables.`);
    const j = await post(groq ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions",
      { Authorization: "Bearer " + key },
      {
        model: groq ? E("GROQ_MODEL", "llama-3.3-70b-versatile") : E("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free"),
        max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }],
      });
    return (j.choices?.[0]?.message?.content || "").trim();
  }
  if (b === "claude") {
    const key = E("ANTHROPIC_API_KEY");
    if (!key) throw new Error("Set ANTHROPIC_API_KEY in Netlify environment variables.");
    const j = await post("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model: E("MODEL", "claude-sonnet-5-5"), max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] });
    return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  }
  if (b === "ollama") {
    const url = E("OLLAMA_URL");
    if (!url) throw new Error("Set OLLAMA_URL to a public address of your Ollama server (e.g. a Cloudflare Tunnel), or use gemini/groq.");
    const j = await post(url.replace(/\/$/, "") + "/api/chat", {},
      { model: E("OLLAMA_MODEL", "llama3.1:8b"), stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
    return (j.message?.content || "").trim();
  }
  throw new Error("Unknown LLM_BACKEND: " + b);
}

export async function jllm(system, user) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const t = await llm(system + "\nReturn ONLY valid JSON, no markdown, no commentary.", user);
      const m = t.match(/[\[{][\s\S]*[\]}]/);
      return JSON.parse(m[0]);
    } catch (e) { err = e; if (/LLM request failed|Set |Unknown LLM/.test(String(e.message))) throw e; }
  }
  throw new Error("Model did not return valid JSON. Try a larger model.");
}
