import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { windowsVault } from "./vault.mjs";
import { getApiKey } from "./credentials.mjs";
import { redact } from "./redact.mjs";
import { validateBaseUrl, PROTOCOLS, providerKind, authHeaders } from "./provider-adapters.mjs";

export const PLATFORM_DIR = fileURLToPath(new URL("./.platform/", import.meta.url));
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();

function safeLabel(value, fallback) {
  const text = String(value ?? fallback).trim();
  if (!text || text.length > 60 || /[\r\n<>]/.test(text) || redact(text).count) throw new Error("Use a short label without credentials or personal information.");
  return text;
}
function modelId(value) {
  if (typeof value !== "string" || !modelPattern.test(value) || redact(value).count) throw new Error("Invalid model ID.");
  return value;
}
function providerFields(input, current = {}) {
  const result = {
    name: safeLabel(input.name ?? current.name, "Custom"),
    protocol: input.protocol ?? current.protocol ?? "openai-chat",
    base_url: validateBaseUrl(input.base_url ?? current.base_url),
    enabled: input.enabled ?? current.enabled ?? true,
    key_policy: input.key_policy ?? current.key_policy ?? "round_robin"
  };
  if (!PROTOCOLS.includes(result.protocol)) throw new Error("Unsupported protocol.");
  if (!["round_robin", "priority"].includes(result.key_policy)) throw new Error("Invalid key policy.");
  if (typeof result.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  const models = input.models ?? current.models ?? [];
  if (!Array.isArray(models) || models.length > 100) throw new Error("Provide up to 100 model IDs.");
  result.models = [...new Set(models.map(modelId))];
  result.default_model = modelId(input.default_model ?? current.default_model ?? result.models[0]);
  if (!result.models.includes(result.default_model)) result.models.unshift(result.default_model);
  return result;
}

export class ProviderRegistry {
  constructor({ directory = PLATFORM_DIR, vault = windowsVault, legacyKey = getApiKey, fetchImpl = fetch } = {}) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "providers.json");
    this.directory = directory;
    this.vault = vault;
    this.legacyKey = legacyKey;
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.tail = Promise.resolve();
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, default_provider_id: null, providers: [] };
    if (this.data.version !== 1 || !Array.isArray(this.data.providers)) throw new Error("Invalid provider configuration.");
  }

  mutate(operation) {
    const pending = this.tail.then(async () => {
      const snapshot = structuredClone(this.data);
      try {
        const result = await operation();
        await this.validateMetadata();
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        renameSync(temporary, this.file);
        return result;
      } catch (error) {
        this.data = snapshot;
        this.cache.clear();
        throw error;
      }
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  async initialize() {
    if (existsSync(this.file)) {
      await this.validateMetadata();
      return;
    }
    const oldKey = await this.legacyKey();
    await this.mutate(async () => {
      const id = randomUUID();
      const keys = [];
      if (oldKey) keys.push(await this.keyRecord("Imported DeepSeek key", oldKey));
      this.data = { version: 1, default_provider_id: id, providers: [{
        id, ...providerFields({ name: "DeepSeek", base_url: "https://api.deepseek.com", protocol: "openai-chat", models: ["deepseek-flash", "deepseek-v4-pro"], default_model: "deepseek-flash" }),
        keys, cursor: 0, created_at: iso(), updated_at: iso()
      }] };
    });
  }

  provider(id) {
    const provider = this.data.providers.find(p => p.id === id);
    if (!provider) throw new Error("Provider not found.");
    return provider;
  }

  async validateMetadata() {
    const secrets = await this.secrets();
    const metadata = this.data.providers.flatMap(provider => [
      provider.name, provider.base_url, provider.default_model, ...provider.models,
      ...provider.keys.map(key => key.label)
    ]);
    if (metadata.some(value => secrets.some(secret => secret && String(value).includes(secret)))) {
      throw new Error("Configuration labels and addresses must not contain API keys.");
    }
  }

  publicData() {
    return {
      default_provider_id: this.data.default_provider_id,
      providers: this.data.providers.map(p => ({
        id: p.id, name: p.name, protocol: p.protocol, base_url: p.base_url,
        enabled: p.enabled, key_policy: p.key_policy, models: [...p.models],
        default_model: p.default_model, created_at: p.created_at,
        keys: p.keys.map(k => ({
          id: k.id, label: k.label, masked: "********", enabled: k.enabled,
          health: k.health, created_at: k.created_at, last_used_at: k.last_used_at ?? null,
          last_tested_at: k.last_tested_at ?? null, error_code: k.error_code ?? null,
          cooldown_until: k.cooldown_until ?? null
        }))
      }))
    };
  }

  async create(input) {
    const fields = providerFields(input);
    return this.mutate(() => {
      if (this.data.providers.length >= 30) throw new Error("Provider limit reached.");
      if (this.data.providers.some(p => p.name === fields.name)) throw new Error("Provider name already exists.");
      const provider = { id: randomUUID(), ...fields, keys: [], cursor: 0, created_at: iso(), updated_at: iso() };
      this.data.providers.push(provider);
      this.data.default_provider_id ??= provider.id;
      return { id: provider.id };
    });
  }

  async update(id, input) {
    return this.mutate(() => {
      const provider = this.provider(id);
      const fields = providerFields(input, provider);
      if (this.data.providers.some(p => p.id !== id && p.name === fields.name)) throw new Error("Provider name already exists.");
      const routingChanged = fields.base_url !== provider.base_url || fields.protocol !== provider.protocol;
      Object.assign(provider, fields, { updated_at: iso() });
      if (routingChanged) {
        for (const key of provider.keys) Object.assign(key, { health: "untested", error_code: null, cooldown_until: null, last_tested_at: null });
      }
      return { id };
    });
  }

  async remove(id) {
    return this.mutate(() => {
      const provider = this.provider(id);
      for (const key of provider.keys) this.cache.delete(key.id);
      this.data.providers = this.data.providers.filter(p => p.id !== id);
      if (this.data.default_provider_id === id) this.data.default_provider_id = this.data.providers.find(p => p.enabled)?.id ?? null;
      return { removed: true };
    });
  }

  async setDefault(id) {
    return this.mutate(() => {
      if (!this.provider(id).enabled) throw new Error("Enable the provider before making it default.");
      this.data.default_provider_id = id;
      return { id };
    });
  }

  async keyRecord(label, value) {
    if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 4096 || /[\r\n]/.test(value)) throw new Error("Invalid API key.");
    const key = value.trim();
    const safe = safeLabel(label, "API key");
    if (safe.includes(key)) throw new Error("Do not use the API key as its label.");
    const id = randomUUID();
    const encrypted = await this.vault.protect(key);
    this.cache.set(id, key);
    return { id, label: safe, encrypted, fingerprint: digest(key), enabled: true, health: "untested", created_at: iso() };
  }

  async addKey(id, input) {
    return this.mutate(async () => {
      const provider = this.provider(id);
      if (provider.keys.length >= 50) throw new Error("Key limit reached.");
      if (typeof input.key !== "string") throw new Error("API key is required.");
      if (provider.keys.some(k => k.fingerprint === digest(input.key.trim()))) throw new Error("This key already exists for this provider.");
      const record = await this.keyRecord(input.label, input.key);
      provider.keys.push(record);
      return { id: record.id };
    });
  }

  async updateKey(id, keyId, input) {
    return this.mutate(async () => {
      const provider = this.provider(id);
      const key = provider.keys.find(k => k.id === keyId);
      if (!key) throw new Error("API key not found.");
      if (input.label != null) key.label = safeLabel(input.label, key.label);
      if (input.enabled != null) {
        if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean.");
        key.enabled = input.enabled;
        if (key.enabled) Object.assign(key, { health: "untested", error_code: null, cooldown_until: null });
      }
      if (input.key != null && input.key !== "") {
        if (provider.keys.some(k => k.id !== keyId && k.fingerprint === digest(String(input.key).trim()))) throw new Error("This key already exists for this provider.");
        const replacement = await this.keyRecord(key.label, input.key);
        Object.assign(key, { encrypted: replacement.encrypted, fingerprint: replacement.fingerprint, health: "untested", error_code: null, cooldown_until: null });
        this.cache.set(keyId, this.cache.get(replacement.id));
        this.cache.delete(replacement.id);
      }
      return { id: keyId };
    });
  }

  async removeKey(id, keyId) {
    return this.mutate(() => {
      const provider = this.provider(id);
      if (!provider.keys.some(k => k.id === keyId)) throw new Error("API key not found.");
      provider.keys = provider.keys.filter(k => k.id !== keyId);
      this.cache.delete(keyId);
      return { removed: true };
    });
  }

  async secrets() {
    const keys = this.data.providers.flatMap(p => p.keys);
    const missing = keys.filter(k => !this.cache.has(k.id));
    const values = await this.vault.unprotectMany(missing.map(k => k.encrypted));
    missing.forEach((key, index) => this.cache.set(key.id, values[index]));
    return keys.map(k => this.cache.get(k.id));
  }

  async acquire(input) {
    return this.mutate(async () => {
      const provider = this.provider(input.provider_id ?? this.data.default_provider_id);
      if (!provider.enabled) throw new Error("Provider is disabled.");
      const model = modelId(input.model ?? provider.default_model);
      const allSecrets = await this.secrets();
      if (allSecrets.some(secret => secret && model.includes(secret))) throw new Error("Invalid model ID.");
      const available = provider.keys.filter(k => k.enabled && (!k.cooldown_until || Date.parse(k.cooldown_until) <= Date.now()) && k.error_code !== "AUTH");
      let selected;
      if (input.key_id) {
        selected = provider.keys.find(k => k.id === input.key_id && k.enabled);
        if (!selected) throw new Error("Selected key is unavailable or belongs to another provider.");
      } else {
        if (!available.length) throw new Error("No enabled, available API key for this provider.");
        selected = available[provider.key_policy === "priority" ? 0 : provider.cursor % available.length];
        provider.cursor = (provider.cursor + 1) % Math.max(available.length, 1);
      }
      selected.last_used_at = iso();
      return {
        key: this.cache.get(selected.id), allSecrets, model,
        base_url: provider.base_url, protocol: provider.protocol, provider: providerKind(provider.base_url),
        provider_id: provider.id, key_id: selected.id
      };
    });
  }

  async noteResult(route, errorCode) {
    return this.mutate(() => {
      const provider = this.data.providers.find(p => p.id === route.provider_id);
      const key = provider?.keys.find(k => k.id === route.key_id);
      // A request for an old endpoint or replaced key must not change new credentials' health.
      if (!key || provider.base_url !== route.base_url || key.fingerprint !== digest(route.key)) return;
      key.health = errorCode ? "error" : "healthy";
      key.error_code = errorCode ?? null;
      key.cooldown_until = errorCode === "RATE_LIMIT" ? new Date(Date.now() + 60000).toISOString() : null;
    });
  }

  async testKey(id, keyId) {
    let route;
    await this.mutate(async () => {
      const provider = this.provider(id);
      const key = provider.keys.find(k => k.id === keyId);
      if (!key) throw new Error("API key not found.");
      await this.secrets();
      route = { provider_id: id, key_id: keyId, key: this.cache.get(keyId), base_url: provider.base_url, protocol: provider.protocol };
    });
    let code = null;
    let models = [];
    try {
      const response = await this.fetch(`${validateBaseUrl(route.base_url)}/models`, {
        headers: authHeaders(route.protocol, route.key), redirect: "error", signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) code = ({ 401: "AUTH", 403: "AUTH", 429: "RATE_LIMIT", 404: "UNSUPPORTED" })[response.status] ?? "PROVIDER";
      else {
        const data = await response.json();
        models = Array.isArray(data.data) ? data.data.map(m => m.id).filter(m => typeof m === "string" && modelPattern.test(m) && !redact(m, [...this.cache.values()]).count).slice(0, 100) : [];
      }
    } catch { code = "NETWORK"; }
    if (code !== "UNSUPPORTED") await this.noteResult(route, code);
    await this.mutate(() => {
      const key = this.data.providers.find(p => p.id === id)?.keys.find(k => k.id === keyId);
      if (key && key.fingerprint === digest(route.key)) key.last_tested_at = iso();
    });
    return { ok: !code, error_code: code, models };
  }
}
