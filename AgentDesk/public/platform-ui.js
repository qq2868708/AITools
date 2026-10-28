(() => {
  const el = id => document.getElementById(id);
  const html = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ui = { data: { providers: [], default_provider_id: null }, selected: null, providerEdit: null, keyEdit: null, token: null, busy: new Set() };
  const protocolNames = { "openai-chat": "OpenAI Chat Completions", "openai-responses": "OpenAI Responses", anthropic: "Anthropic Messages" };
  const healthNames = { healthy: "可用", untested: "未验证", error: "异常" };
  const errorNames = { AUTH: "鉴权失败", BALANCE: "余额不足", RATE_LIMIT: "请求限流", NETWORK: "连接失败", PROVIDER: "接口错误", EMPTY_RESPONSE: "未返回答案文本", OUTPUT_LIMIT: "输出额度耗尽，未生成答案", UNSUPPORTED: "该接口不支持模型列表验证" };
  const errorMessages = {
    "Provider name already exists.": "供应商名称已存在。",
    "This key already exists for this provider.": "该供应商已保存此密钥。",
    "No enabled, available API key for this provider.": "该供应商没有已启用且可用的密钥。",
    "Provider is disabled.": "该供应商已停用。",
    "Invalid API key.": "请输入有效的 API key。",
    "API key is required.": "请输入 API key。",
    "Invalid model ID.": "请填写有效的模型 ID。",
    "This provider or key has an active task. Wait or cancel it before deleting.": "当前仍有任务使用此供应商或密钥，请先等待或取消任务。",
    "Two jobs are already running. Wait for a result before submitting another.": "已有两个任务运行中，请等待任务完成。",
    "Use a short label without credentials or personal information.": "名称请保持简短，不要包含密钥或个人信息。",
    "Invalid session token. Reload the page.": "会话已更新，请刷新页面后重试。"
  };
  const fmt = value => new Intl.NumberFormat("zh-CN").format(value);
  const current = () => ui.data.providers.find(provider => provider.id === ui.selected);
  const icons = () => window.lucide?.createIcons();
  const jobs = () => window.monitorAPI?.jobs() ?? [];
  let logsVersionChecked = false;
  let retryJob = null;
  async function requireRequestLogs() {
    if (logsVersionChecked) return;
    const health = await api("/health");
    if (!health.request_logs || health.version < 3) throw new Error("当前服务需要重启，才能加载请求记录功能。");
    logsVersionChecked = true;
  }
  function date(value) {
    return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "尚未验证";
  }
  function message(text) {
    el("toast").textContent = text;
    el("toast").hidden = false;
    clearTimeout(message.timer);
    message.timer = setTimeout(() => { el("toast").hidden = true; }, 3500);
  }
  function errorText(error) { return errorMessages[error.message] ?? error.message ?? "操作失败，请重试。"; }
  async function api(path, method = "GET", body) {
    const headers = {};
    if (method !== "GET") {
      if (!ui.token) {
        const session = await fetch("/api/session", { signal: AbortSignal.timeout(5000) });
        if (!session.ok) throw new Error("无法获取本机会话，请刷新页面。");
        ui.token = (await session.json()).token;
      }
      headers["X-Platform-Token"] = ui.token;
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), cache: "no-store" });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 403) ui.token = null;
      throw new Error(result.error ?? "请求失败。");
    }
    return result;
  }
  function vendor(provider) {
    const host = new URL(provider.base_url).hostname;
    return ({ "api.deepseek.com": ["deepseek", "D"], "api.openai.com": ["openai", "O"], "api.anthropic.com": ["anthropic", "A"] })[host] ?? ["custom", provider.name.slice(0, 1).toUpperCase()];
  }
  function switchView(view) {
    const providers = view !== "tasks";
    el("providers-page").hidden = !providers;
    el("tasks-page").hidden = providers;
    el("nav-providers").classList.toggle("active", providers);
    el("nav-tasks").classList.toggle("active", !providers);
    el("mobile-providers").classList.toggle("active", providers);
    el("mobile-tasks").classList.toggle("active", !providers);
    el("breadcrumb-current").textContent = providers ? "供应商与密钥" : "子任务监控";
    if (!providers) window.monitorAPI?.render();
    history.replaceState(null, "", providers ? "#providers" : "#tasks");
    window.scrollTo(0, 0);
  }
  function render() {
    const providers = ui.data.providers;
    window.providerData = ui.data;
    el("provider-nav-count").textContent = providers.length;
    el("provider-total").textContent = providers.length;
    el("key-total").textContent = providers.filter(p => p.enabled).reduce((sum, p) => sum + p.keys.filter(k => k.enabled).length, 0);
    el("default-provider-name").textContent = providers.find(p => p.id === ui.data.default_provider_id)?.name ?? "未设置";
    const search = el("provider-search").value.toLowerCase().trim();
    const matched = providers.filter(p => `${p.name} ${p.base_url}`.toLowerCase().includes(search));
    el("provider-list").innerHTML = matched.length ? matched.map(p => {
      const [style, symbol] = vendor(p);
      return `<button class="provider-item ${p.id === ui.selected ? "selected" : ""}" data-provider="${p.id}" aria-pressed="${p.id === ui.selected}"><span class="vendor-symbol ${style}">${html(symbol)}</span><span class="provider-item-text"><span class="provider-item-name">${html(p.name)}</span><span class="provider-item-meta ${p.enabled ? "" : "disabled"}">${p.enabled ? `${p.keys.filter(k => k.enabled).length} / ${p.keys.length} 密钥已启用` : "已停用"}</span></span>${p.id === ui.data.default_provider_id ? '<i data-lucide="star" aria-label="默认供应商"></i>' : ""}</button>`;
    }).join("") : `<div class="no-match">${providers.length ? "没有匹配的供应商" : "暂无供应商"}</div>`;
    const filter = el("provider-filter");
    const previous = filter.value;
    filter.innerHTML = `<option value="all">全部供应商</option>${providers.map(p => `<option value="${p.id}">${html(p.name)}</option>`).join("")}`;
    filter.value = [...filter.options].some(o => o.value === previous) ? previous : "all";
    renderDetail();
    icons();
  }
  function renderDetail() {
    const provider = current();
    if (!provider) {
      el("provider-detail").innerHTML = '<div class="empty"><i data-lucide="network"></i><h3>暂无供应商</h3><p>添加一个供应商以开始接入</p></div>';
      return;
    }
    const [style, symbol] = vendor(provider);
    const defaulted = provider.id === ui.data.default_provider_id;
    const related = jobs().filter(job => job.provider_id === provider.id);
    const totalTokens = related.reduce((sum, job) => sum + (job.total_tokens ?? 0), 0);
    el("provider-detail").innerHTML = `
      <div class="provider-detail-heading"><div class="provider-identity"><span class="vendor-symbol ${style}">${html(symbol)}</span><div><h2>${html(provider.name)}</h2><span class="badge ${provider.enabled ? "completed" : "cancelled"}">${provider.enabled ? "已启用" : "已停用"}</span>${defaulted ? '<span class="default-mark">默认供应商</span>' : ""}</div></div>
      <div class="provider-controls">
        <label class="switch-label" title="启停供应商"><input type="checkbox" data-action="toggle-provider" aria-label="启用供应商" ${provider.enabled ? "checked" : ""}><span class="switch"></span></label>
        <button class="icon-button ${defaulted ? "is-default" : ""}" data-action="default-provider" aria-label="设为默认供应商" title="设为默认供应商" ${defaulted ? "disabled" : ""}><i data-lucide="star"></i></button>
        <button class="icon-button" data-action="edit-provider" aria-label="编辑供应商" title="编辑供应商"><i data-lucide="settings-2"></i></button>
        <button class="icon-button" data-action="delete-provider" aria-label="删除供应商" title="删除供应商"><i data-lucide="trash-2"></i></button>
      </div></div>
      <code class="provider-endpoint">${html(provider.base_url)}</code>
      <dl class="provider-settings"><div><dt>接入协议</dt><dd>${protocolNames[provider.protocol]}</dd></div><div><dt>密钥选择</dt><dd>${provider.key_policy === "round_robin" ? "轮询已启用密钥" : "优先首个可用密钥"}</dd></div><div><dt>默认模型</dt><dd>${html(provider.default_model)}</dd></div><div><dt>近 7 天任务 / Tokens</dt><dd>${fmt(related.length)} / ${fmt(totalTokens)}</dd></div></dl>
      <div class="model-list">${provider.models.map(model => `<span class="model-tag">${html(model)}</span>`).join("")}</div>
      <div class="key-section-heading"><h3>API Keys <small>${provider.keys.length} 把密钥</small></h3><button class="button" data-action="add-key"><i data-lucide="plus"></i>添加密钥</button></div>
      ${provider.keys.length ? `<div class="key-table-wrap"><table class="key-table"><thead><tr><th>名称 / 密钥编号</th><th>验证状态</th><th>任务 / Tokens</th><th>操作</th></tr></thead><tbody>${provider.keys.map(key => {
        const keyJobs = related.filter(job => job.key_id === key.id);
        const tokens = keyJobs.reduce((sum, job) => sum + (job.total_tokens ?? 0), 0);
        const busy = ui.busy.has(key.id);
        return `<tr data-key="${key.id}"><td><div class="key-label">${html(key.label)}</div><div class="key-mask">******** · ${key.id.slice(0, 6)}</div></td><td><span class="health ${key.health}">${key.enabled ? (busy ? "验证中" : healthNames[key.health]) : "已停用"}</span><div class="key-sub">${key.error_code ? html(errorNames[key.error_code] ?? "请求错误") : date(key.last_tested_at)}</div></td><td>${keyJobs.length} / ${fmt(tokens)}</td><td><div class="key-actions"><label class="switch-label" title="启停密钥"><input type="checkbox" data-action="toggle-key" aria-label="启用密钥 ${html(key.label)}" ${key.enabled ? "checked" : ""}><span class="switch"></span></label><button class="icon-button" data-action="test-key" aria-label="验证密钥 ${html(key.label)}" title="验证密钥（查询模型列表）" ${busy ? "disabled" : ""}><i data-lucide="${busy ? "loader-circle" : "plug-zap"}" ${busy ? 'class="busy-icon"' : ""}></i></button><button class="icon-button" data-action="edit-key" aria-label="编辑密钥 ${html(key.label)}" title="编辑密钥"><i data-lucide="pencil"></i></button><button class="icon-button" data-action="delete-key" aria-label="删除密钥 ${html(key.label)}" title="删除密钥"><i data-lucide="trash-2"></i></button></div></td></tr>`;
      }).join("")}</tbody></table></div>` : '<div class="empty"><span class="empty-icon"><i data-lucide="key-round"></i></span><h3>尚未添加密钥</h3></div>'}`;
    icons();
  }
  async function load() {
    try {
      ui.data = await api("/api/providers");
      if (!ui.data.providers.some(p => p.id === ui.selected)) ui.selected = ui.data.default_provider_id ?? ui.data.providers[0]?.id ?? null;
      el("provider-alert").hidden = true;
      render();
      window.monitorAPI?.render();
    } catch (error) {
      el("provider-alert").hidden = false;
      el("provider-alert").textContent = errorText(error);
    }
  }
  function showError(id, error) {
    el(id).hidden = false;
    el(id).textContent = errorText(error);
  }
  function openProvider(provider = null) {
    ui.providerEdit = provider?.id ?? null;
    el("provider-form").reset();
    el("provider-form-error").hidden = true;
    el("template-field").hidden = Boolean(provider);
    el("provider-modal-title").textContent = provider ? "编辑供应商" : "添加供应商";
    el("provider-name").value = provider?.name ?? "";
    el("provider-protocol").value = provider?.protocol ?? "openai-chat";
    el("provider-url").value = provider?.base_url ?? "";
    el("provider-models").value = provider?.models.join("\n") ?? "";
    el("provider-default-model").value = provider?.default_model ?? "";
    el("provider-policy").value = provider?.key_policy ?? "round_robin";
    el("provider-modal").showModal();
  }
  function openKey(key = null) {
    ui.keyEdit = key?.id ?? null;
    el("key-form").reset();
    el("key-value").type = "password";
    el("toggle-key").innerHTML = '<i data-lucide="eye"></i>';
    el("toggle-key").setAttribute("aria-label", "显示输入的密钥");
    el("toggle-key").title = "显示输入的密钥";
    el("key-form-error").hidden = true;
    el("key-modal-title").textContent = key ? "编辑密钥" : "添加密钥";
    el("key-label").value = key?.label ?? "";
    el("key-value").required = !key;
    el("key-value-label").textContent = key ? "替换 API Key（可选）" : "API Key";
    el("key-help").textContent = key ? "留空则保留现有密钥。" : "使用当前 Windows 账户加密保存，保存后不再回显。";
    el("key-modal").showModal();
    icons();
  }
  async function withForm(form, errorId, operation) {
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    el(errorId).hidden = true;
    try { await operation(); } catch (error) { showError(errorId, error); }
    finally { button.disabled = false; }
  }
  function confirmDelete(text, operation) {
    el("confirm-message").textContent = text;
    el("confirm-error").hidden = true;
    el("confirm-action").onclick = async () => {
      el("confirm-action").disabled = true;
      try {
        await operation();
        el("confirm-modal").close();
        await load();
        message("已删除");
      } catch (error) { showError("confirm-error", error); }
      finally { el("confirm-action").disabled = false; }
    };
    el("confirm-modal").showModal();
  }
  async function openLogging() {
    el("logging-error").hidden = true;
    el("save-logging").disabled = true;
    el("capture-bodies").disabled = true;
    el("logging-modal").showModal();
    try {
      await requireRequestLogs();
      const settings = await api("/api/logging");
      el("capture-bodies").checked = settings.capture_bodies;
      el("capture-bodies").disabled = false;
      el("save-logging").disabled = false;
    } catch (error) { showError("logging-error", error); }
  }
  function openRetry(jobId) {
    const job = jobs().find(item => item.id === jobId);
    if (!job) return message("该请求记录已不在保留范围内。");
    retryJob = jobId;
    const provider = ui.data.providers.find(item => item.id === job.provider_id);
    el("retry-summary").textContent = `${provider?.name ?? job.provider} · ${job.model} · 第 ${job.attempt ?? 1} 次请求 ${jobId.slice(0, 8)}`;
    el("retry-key").innerHTML = '<option value="">按供应商策略选择</option>' + (provider?.keys.filter(key => key.enabled).map(key => `<option value="${key.id}">${html(key.label)} · ${key.id.slice(0, 6)}</option>`).join("") ?? "");
    el("retry-error").hidden = true;
    el("retry-modal").showModal();
  }
  function taskRouting() {
    const provider = ui.data.providers.find(p => p.id === el("task-provider").value);
    el("task-model").innerHTML = provider?.models.map(model => `<option value="${html(model)}">${html(model)}</option>`).join("") ?? "";
    if (provider) el("task-model").value = provider.default_model;
    el("task-key").innerHTML = '<option value="">按供应商策略选择</option>' + (provider?.keys.filter(key => key.enabled).map(key => `<option value="${key.id}">${html(key.label)} · ${key.id.slice(0, 6)}</option>`).join("") ?? "");
  }
  async function openTask() {
    await load();
    const available = ui.data.providers.filter(p => p.enabled && p.keys.some(key => key.enabled));
    if (!available.length) return message("请先添加并启用供应商及 API key。");
    el("task-form").reset();
    el("task-form-error").hidden = true;
    el("task-provider").innerHTML = available.map(p => `<option value="${p.id}">${html(p.name)}</option>`).join("");
    const preferred = available.find(p => p.id === ui.selected) ?? available.find(p => p.id === ui.data.default_provider_id) ?? available[0];
    el("task-provider").value = preferred.id;
    taskRouting();
    el("task-modal").showModal();
  }
  el("provider-list").addEventListener("click", event => {
    const button = event.target.closest("[data-provider]");
    if (button) { ui.selected = button.dataset.provider; render(); }
  });
  el("provider-detail").addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const provider = current();
    const keyId = button.closest("[data-key]")?.dataset.key;
    const key = provider.keys.find(item => item.id === keyId);
    const path = `/api/providers/${provider.id}`;
    try {
      switch (button.dataset.action) {
        case "edit-provider": openProvider(provider); break;
        case "add-key": openKey(); break;
        case "edit-key": openKey(key); break;
        case "default-provider": await api(`${path}/default`, "POST", {}); await load(); message("默认供应商已更新"); break;
        case "delete-provider": confirmDelete(`删除“${provider.name}”及其 ${provider.keys.length} 把密钥？历史任务记录将保留。`, () => api(path, "DELETE", {})); break;
        case "delete-key": confirmDelete(`删除密钥“${key.label}”？历史任务记录将保留。`, () => api(`${path}/keys/${keyId}`, "DELETE", {})); break;
        case "test-key": {
          if (ui.busy.has(keyId)) return;
          ui.busy.add(keyId); renderDetail();
          try {
            const result = await api(`${path}/keys/${keyId}/test`, "POST", {});
            message(result.ok ? `密钥验证成功，可见 ${result.models.length} 个模型` : `验证未通过：${errorNames[result.error_code] ?? "接口错误"}`);
          } finally { ui.busy.delete(keyId); await load(); }
          break;
        }
      }
    } catch (error) { message(errorText(error)); }
  });
  el("provider-detail").addEventListener("change", async event => {
    const target = event.target;
    if (!target.matches("input[data-action]")) return;
    target.disabled = true;
    const provider = current();
    const keyId = target.closest("[data-key]")?.dataset.key;
    try {
      await api(`/api/providers/${provider.id}${keyId ? `/keys/${keyId}` : ""}`, "PATCH", { enabled: target.checked });
    } catch (error) { message(errorText(error)); }
    await load();
  });
  el("provider-form").addEventListener("submit", event => {
    event.preventDefault();
    withForm(event.target, "provider-form-error", async () => {
      const result = await api(`/api/providers${ui.providerEdit ? `/${ui.providerEdit}` : ""}`, ui.providerEdit ? "PATCH" : "POST", {
        name: el("provider-name").value.trim(), protocol: el("provider-protocol").value,
        base_url: el("provider-url").value.trim(), models: el("provider-models").value.split(/[,\n，]/).map(v => v.trim()).filter(Boolean),
        default_model: el("provider-default-model").value.trim(), key_policy: el("provider-policy").value
      });
      ui.selected = result.id;
      el("provider-modal").close();
      await load(); message("供应商已保存");
    });
  });
  el("key-form").addEventListener("submit", event => {
    event.preventDefault();
    withForm(event.target, "key-form-error", async () => {
      const path = `/api/providers/${ui.selected}/keys${ui.keyEdit ? `/${ui.keyEdit}` : ""}`;
      await api(path, ui.keyEdit ? "PATCH" : "POST", { label: el("key-label").value.trim(), key: el("key-value").value });
      el("key-value").value = "";
      el("key-modal").close();
      await load(); message("密钥已加密保存");
    });
  });
  el("key-modal").addEventListener("close", () => { el("key-value").value = ""; el("key-value").type = "password"; });
  el("key-modal").addEventListener("cancel", () => { el("key-value").value = ""; });
  el("toggle-key").addEventListener("click", () => {
    const showing = el("key-value").type === "password";
    el("key-value").type = showing ? "text" : "password";
    el("toggle-key").setAttribute("aria-label", showing ? "隐藏输入的密钥" : "显示输入的密钥");
    el("toggle-key").title = showing ? "隐藏输入的密钥" : "显示输入的密钥";
    el("toggle-key").innerHTML = `<i data-lucide="${showing ? "eye-off" : "eye"}"></i>`;
    icons();
  });
  el("provider-template").addEventListener("change", () => {
    const presets = {
      custom: ["", "openai-chat", "", ""],
      deepseek: ["DeepSeek", "openai-chat", "https://api.deepseek.com", "deepseek-flash\ndeepseek-v4-pro"],
      openai: ["OpenAI", "openai-responses", "https://api.openai.com/v1", ""],
      anthropic: ["Anthropic", "anthropic", "https://api.anthropic.com/v1", ""]
    };
    const preset = presets[el("provider-template").value];
    el("provider-name").value = preset[0]; el("provider-protocol").value = preset[1];
    el("provider-url").value = preset[2]; el("provider-models").value = preset[3];
    el("provider-default-model").value = preset[3].split("\n")[0];
  });
  el("task-provider").addEventListener("change", taskRouting);
  el("task-form").addEventListener("submit", event => {
    event.preventDefault();
    withForm(event.target, "task-form-error", async () => {
      const args = {
        provider_id: el("task-provider").value, model: el("task-model").value,
        role: el("task-role").value,
        task: el("task-prompt").value, context: el("task-context").value
      };
      if (el("task-max-tokens").value.trim()) args.max_tokens = Number(el("task-max-tokens").value);
      if (el("task-key").value) args.key_id = el("task-key").value;
      const result = await api("/api/rpc", "POST", { action: "task_submit", args });
      el("task-form").reset(); el("task-modal").close();
      switchView("tasks"); await window.monitorAPI?.refresh();
      message(`任务已派发 · ${result.job_id.slice(0, 8)}`);
    });
  });
  el("task-modal").addEventListener("close", () => { el("task-prompt").value = ""; el("task-context").value = ""; });
  el("logging-settings").addEventListener("click", openLogging);
  el("logging-form").addEventListener("submit", event => {
    event.preventDefault();
    withForm(event.target, "logging-error", async () => {
      await api("/api/logging", "PATCH", { capture_bodies: el("capture-bodies").checked });
      el("logging-modal").close();
      message("记录设置已保存，对新请求生效");
    });
  });
  el("retry-form").addEventListener("submit", event => {
    event.preventDefault();
    withForm(event.target, "retry-error", async () => {
      const args = { job_id: retryJob };
      if (el("retry-key").value) args.key_id = el("retry-key").value;
      const result = await api("/api/rpc", "POST", { action: "task_retry", args });
      el("retry-modal").close();
      await window.monitorAPI?.refresh();
      window.monitorAPI?.select(result.job_id, "recovery");
      message(`已创建第 ${result.attempt} 次请求 · ${result.job_id.slice(0, 8)}`);
    });
  });
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.close === "key-modal") el("key-value").value = "";
    el(button.dataset.close).close();
  }));
  for (const id of ["nav-providers", "mobile-providers"]) el(id).addEventListener("click", () => switchView("providers"));
  for (const id of ["nav-tasks", "mobile-tasks"]) el(id).addEventListener("click", () => switchView("tasks"));
  for (const id of ["new-task", "dispatch-task"]) el(id).addEventListener("click", openTask);
  el("provider-privacy-link").addEventListener("click", () => el("privacy").showModal());
  el("add-provider").addEventListener("click", () => openProvider());
  el("refresh-providers").addEventListener("click", load);
  el("provider-search").addEventListener("input", render);
  window.addEventListener("monitor-updated", renderDetail);
  window.addEventListener("hashchange", () => switchView(location.hash === "#tasks" ? "tasks" : "providers"));
  window.platformUI = {
    openLogging, openRetry,
    async traceTask(job_id, include_body = false) {
      await requireRequestLogs();
      return api("/api/rpc", "POST", { action: "task_trace", args: { job_id, include_body } });
    },
    async cancelTask(job_id) {
      await api("/api/rpc", "POST", { action: "task_cancel", args: { job_id } });
      await window.monitorAPI?.refresh();
      message("已停止本地等待");
    },
    load
  };
  switchView(location.hash === "#tasks" ? "tasks" : "providers");
  load();
})();
