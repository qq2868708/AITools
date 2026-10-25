export const PROTOCOLS = ["openai-chat", "openai-responses", "anthropic"];

export function validateBaseUrl(value) {
  if (typeof value !== "string" || value.length > 300) throw new Error("Base URL is invalid.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Base URL is invalid."); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Use HTTPS (or local HTTP), without embedded credentials, query or fragment.");
  }
  if (/\/(?:chat\/completions|responses|messages|models)\/?$/.test(url.pathname)) {
    throw new Error("Enter the API base URL, excluding chat/completions, responses, messages or models.");
  }
  return url.href.replace(/\/+$/, "");
}

export function providerKind(baseUrl) {
  const host = new URL(baseUrl).hostname;
  return ({ "api.deepseek.com": "DeepSeek", "api.openai.com": "OpenAI", "api.anthropic.com": "Anthropic" })[host] ?? "Custom";
}

export function authHeaders(protocol, key) {
  return protocol === "anthropic"
    ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

export function buildRequest({ protocol, base_url, key }, { model, messages, max_tokens }) {
  const base = validateBaseUrl(base_url);
  let body;
  let suffix;
  if (protocol === "anthropic") {
    suffix = "/messages";
    body = { model, system: messages.filter(m => m.role === "system").map(m => m.content).join("\n"),
      messages: messages.filter(m => m.role !== "system"), max_tokens, stream: false };
  } else if (protocol === "openai-responses") {
    suffix = "/responses";
    body = { model, input: messages, max_output_tokens: max_tokens, stream: false, store: false };
  } else {
    suffix = "/chat/completions";
    body = { model, messages, stream: false };
    if (providerKind(base) === "OpenAI") body.max_completion_tokens = max_tokens;
    else body.max_tokens = max_tokens;
    if (providerKind(base) === "DeepSeek") body.thinking = { type: "disabled" };
  }
  return { url: `${base}${suffix}`, headers: authHeaders(protocol, key), body };
}

export function parseResponse(protocol, data) {
  const numeric = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  if (protocol === "anthropic") {
    const input = numeric(data.usage?.input_tokens);
    const output = numeric(data.usage?.output_tokens);
    const cacheRead = numeric(data.usage?.cache_read_input_tokens) ?? 0;
    const cacheCreate = numeric(data.usage?.cache_creation_input_tokens) ?? 0;
    return {
      text: data.content?.filter(part => part.type === "text").map(part => part.text).join("\n"),
      model: data.model, finish_reason: data.stop_reason,
      truncated: data.stop_reason === "max_tokens",
      usage: { prompt_tokens: input == null ? undefined : input + cacheRead + cacheCreate,
        completion_tokens: output, total_tokens: input == null || output == null ? undefined : input + output + cacheRead + cacheCreate }
    };
  }
  if (protocol === "openai-responses") {
    if (data.error || data.status === "failed") throw new Error("Provider response failed.");
    return {
      text: data.output?.filter(item => item.type === "message").flatMap(item => item.content ?? [])
        .filter(part => part.type === "output_text").map(part => part.text).join("\n"),
      model: data.model, finish_reason: data.incomplete_details?.reason ?? data.status,
      truncated: data.status === "incomplete",
      usage: { prompt_tokens: numeric(data.usage?.input_tokens), completion_tokens: numeric(data.usage?.output_tokens), total_tokens: numeric(data.usage?.total_tokens) }
    };
  }
  return {
    text: data.choices?.[0]?.message?.content,
    model: data.model, finish_reason: data.choices?.[0]?.finish_reason,
    truncated: data.choices?.[0]?.finish_reason === "length",
    usage: { prompt_tokens: numeric(data.usage?.prompt_tokens), completion_tokens: numeric(data.usage?.completion_tokens), total_tokens: numeric(data.usage?.total_tokens) }
  };
}
