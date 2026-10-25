const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[PRIVATE_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [CREDENTIAL]"],
  [/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b/g, "[API_KEY]"],
  [/\b(?:ghp|gho|github_pat|xoxb|xoxp)[_-][A-Za-z0-9_-]{10,}\b/g, "[API_KEY]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[JWT]"],
  [/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[CREDENTIAL]"],
  [/\bhttps?:\/\/[^\s<>"']+/gi, "[URL]"],
  [/\b[A-Z]:[\\/](?:[^\s<>"'|,;]+)/gi, "[LOCAL_PATH]"],
  [/(?:\/(?:Users|home|root|etc|var|mnt|opt|tmp)\/)[^\s<>"',;]+/g, "[LOCAL_PATH]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]"],
  [/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[PHONE]"],
  [/(?<!\d)(?:\+1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\d)/g, "[PHONE]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP_ADDRESS]"]
];

export function redact(text, secrets = []) {
  let value = String(text);
  let count = 0;
  for (const secret of secrets.filter(s => typeof s === "string" && s.length > 0)) {
    const matches = value.split(secret);
    count += matches.length - 1;
    value = matches.join("[CREDENTIAL]");
  }
  for (const [pattern, replacement] of RULES) {
    value = value.replace(pattern, (...args) => {
      count++;
      return replacement.replace(/\$(\d+)/g, (_, index) => args[Number(index)] ?? "");
    });
  }
  return { text: value, count };
}
