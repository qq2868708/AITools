const $ = id => document.getElementById(id);
const state = { jobs: [], filter: "all", selected: null, loading: false, synced: null, detailTab: "overview", audits: new Map(), auditLoading: new Set() };
const roles = { analyst: "分析", reviewer: "审查", planner: "规划" };
const roleIcons = { analyst: "scan-search", reviewer: "file-check-2", planner: "git-branch" };
const labels = { running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "连接中断" };
const errorLabels = { AUTH: "鉴权失败", BALANCE: "余额不足", RATE_LIMIT: "请求限流", BAD_REQUEST: "参数错误", PROVIDER: "服务端错误", NETWORK: "网络或响应错误", TIMEOUT: "本地等待超时", EMPTY_RESPONSE: "返回内容为空" };
Object.assign(errorLabels, { OUTPUT_LIMIT: "输出额度耗尽，未生成答案", INTERRUPTED: "进程中断，远端结果未知", RECORDING: "请求记录失败，未发送" });
const eventLabels = { accepted: "接收请求", routed: "选择供应商与密钥", redacted: "完成输入脱敏", request_saved: "请求正文已加密保存", sent: "发送 API 请求", headers_received: "收到 HTTP 响应", response_received: "收到响应内容", completed: "请求完成", failed: "请求失败", timed_out: "本地等待超时", cancelled: "停止本地等待", interrupted: "恢复启动时发现中断", response_saved: "响应记录已加密保存", recording_failed: "正文记录失败", retry_created: "创建手动重试" };
const number = value => new Intl.NumberFormat("zh-CN").format(value ?? 0);
const time = value => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "—";
const day = value => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(new Date(value));
const icons = () => window.lucide?.createIcons();
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const elapsed = job => Math.max(0, (Date.parse(job.finished_at ?? (job.status === "interrupted" ? job.updated_at : new Date().toISOString())) - Date.parse(job.created_at)) / 1000);
function duration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
const badge = job => `<span class="badge ${escape(job.status)}">${escape(labels[job.status] ?? job.status)}</span>`;
function notify(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { $("toast").hidden = true; }, 3000);
}
function drawChart() {
  const canvas = $("activity");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const bins = Array(12).fill(0);
  const now = Date.now();
  for (const job of state.jobs) {
    const age = now - Date.parse(job.created_at);
    if (age >= 0 && age < 3600000) bins[Math.min(11, 11 - Math.floor(age / 300000))]++;
  }
  const max = Math.max(1, ...bins);
  const gap = 5;
  const width = (rect.width - gap * 11) / 12;
  bins.forEach((value, index) => {
    ctx.fillStyle = "#edf2ef";
    ctx.fillRect(index * (width + gap), 1, width, rect.height - 2);
    const height = value ? Math.max(3, value / max * (rect.height - 5)) : 0;
    ctx.fillStyle = index === 11 ? "#268b77" : "#9dc6b3";
    ctx.fillRect(index * (width + gap), rect.height - height - 1, width, height);
  });
  $("recent-count").textContent = number(bins.reduce((sum, value) => sum + value, 0));
  canvas.setAttribute("aria-label", `过去一小时每五分钟派发数量，从早到晚：${bins.join("、")}`);
}
function render() {
  const jobs = state.jobs;
  const running = jobs.filter(job => job.status === "running").length;
  const completed = jobs.filter(job => job.status === "completed").length;
  const attention = jobs.filter(job => ["failed", "interrupted"].includes(job.status)).length;
  const tokens = jobs.reduce((sum, job) => sum + (job.total_tokens ?? 0), 0);
  $("metric-total").textContent = number(jobs.length);
  $("metric-running").textContent = number(running);
  $("metric-complete").textContent = number(completed);
  $("metric-tokens").textContent = number(tokens);
  $("running-note").textContent = running ? "供应商正在处理" : "暂无进行中的任务";
  $("complete-note").textContent = attention ? `${number(attention)} 条任务需关注` : completed ? "任务结果已返回" : "暂无完成记录";
  $("token-note").textContent = "仅统计 API 已返回用量";
  for (const id of ["nav-count", "queue-count", "tab-all"]) $(id).textContent = number(jobs.length);
  $("tab-running").textContent = number(running);
  $("tab-attention").textContent = number(attention);
  let shown = jobs.filter(job => {
    if (state.filter === "running" && job.status !== "running") return false;
    if (state.filter === "attention" && !["failed", "interrupted"].includes(job.status)) return false;
    if ($("role").value !== "all" && job.role !== $("role").value) return false;
    if ($("provider-filter").value !== "all" && job.provider_id !== $("provider-filter").value) return false;
    return `${job.id} ${job.parent_id ?? ""}`.toLowerCase().includes($("search").value.trim().toLowerCase());
  });
  shown.sort((a, b) => $("sort").value === "duration" ? elapsed(b) - elapsed(a) :
    $("sort").value === "tokens" ? (b.total_tokens ?? 0) - (a.total_tokens ?? 0) : b.created_at.localeCompare(a.created_at));
  $("jobs").innerHTML = shown.map(job => `<tr tabindex="0" data-id="${escape(job.id)}" aria-label="${escape(roles[job.role])}任务 ${escape(job.id.slice(0, 8))}，${escape(labels[job.status])}">
    <td><div class="task-cell"><span class="task-icon"><i data-lucide="${roleIcons[job.role]}"></i></span><div><div class="task-title">${escape(roles[job.role])}任务 <span>#${escape(job.id.slice(0, 6))}</span></div><div class="task-sub">${escape(window.providerData?.providers.find(p => p.id === job.provider_id)?.name ?? job.provider)} · ${escape(job.model)}</div></div></div></td>
    <td>${badge(job)}${job.attempt > 1 ? `<span class="time-secondary">第 ${job.attempt} 次请求</span>` : ""}</td><td>${time(job.created_at)}<span class="time-secondary">${day(job.created_at)}</span></td>
    <td>${duration(elapsed(job))}</td><td>${job.total_tokens == null ? "—" : number(job.total_tokens)}</td>
    <td><span class="protection" title="${job.redactions ? `已替换 ${job.redactions} 处匹配内容` : "已过滤，未匹配到敏感模式"}"><i data-lucide="shield-check"></i>${job.redactions ? `${job.redactions} 处` : "已过滤"}</span></td>
    <td><i class="row-arrow" data-lucide="chevron-right"></i></td></tr>`).join("");
  $("empty").hidden = shown.length > 0;
  $("empty-title").textContent = jobs.length ? "没有匹配的任务" : "暂无子任务";
  $("empty-text").textContent = jobs.length ? "当前筛选结果为空" : "等待下一次派发";
  $("visible-count").textContent = `${number(shown.length)} / ${number(jobs.length)} 条记录`;
  $("updated-at").textContent = state.synced ? `最近同步 ${time(state.synced)}` : "等待同步";
  drawChart();
  if ($("detail").open) renderDetail();
  icons();
  window.dispatchEvent(new Event("monitor-updated"));
}
function renderDetail() {
  const job = state.jobs.find(item => item.id === state.selected);
  if (!job) {
    $("detail-content").textContent = "此任务已不在保留记录中。";
    return;
  }
  $("detail-title").textContent = `${roles[job.role]}任务`;
  const fields = [
    ["供应商", window.providerData?.providers.find(p => p.id === job.provider_id)?.name ?? job.provider],
    ["密钥编号", job.key_id ?? "历史记录未关联"], ["模型", job.model], ["角色", roles[job.role]],
    ["父任务", job.parent_id ?? "独立任务"],
    ["关联 ID", job.trace_id ?? job.id],
    ["请求次数", `第 ${job.attempt ?? 1} 次`],
    ["HTTP 状态", job.http_status ?? "—"],
    ["耗时", duration(elapsed(job))],
    ["输入 / 输出字符", `${number(job.input_chars)} / ${number(job.output_chars)}`],
    ["输入 / 输出 Tokens", `${job.prompt_tokens == null ? "—" : number(job.prompt_tokens)} / ${job.completion_tokens == null ? "—" : number(job.completion_tokens)}`],
    ["推理 Tokens", job.reasoning_tokens == null ? "—" : number(job.reasoning_tokens)],
    ["响应状态", job.response_status ?? "—"],
    ["结束原因", job.finish_reason ?? "—"],
    ["响应内容类型", job.content_types?.join(", ") || "—"],
    ["输出上限", job.max_tokens == null ? "未设置（由上游决定）" : `${number(job.max_tokens)} tokens`],
    ["脱敏替换", `${number(job.redactions)} 处`],
    ["输出截断", job.truncated ? "是" : "否"]
  ];
  if (job.error_code) fields.push(["错误分类", errorLabels[job.error_code] ?? "未知"]);
  const audit = state.audits.get(job.id);
  let content;
  if (state.detailTab === "exchange") {
    const body = audit?.body;
    content = audit?.error ? `<p class="audit-warning">${escape(audit.error)}</p>` : !audit ? '<p class="audit-muted">正在读取记录…</p>' : !audit.body_available
      ? '<div class="audit-empty"><i data-lucide="file-lock-2"></i><h3>未保存此请求的正文</h3><p>默认只保留元数据；开启正文记录后，对新请求生效。</p><button class="button" id="open-logging">记录设置</button></div>'
      : !body ? '<p class="audit-muted">正在解密脱敏正文…</p>'
      : `<div class="audit-section-heading"><h3>请求</h3><span>${body.request_truncated ? "已截断 · 无法从此记录恢复" : "脱敏 · 加密存储"}</span></div><pre class="audit-body">${escape(JSON.stringify(body.request, null, 2))}</pre>
      <div class="audit-section-heading"><h3>响应</h3><span>${body.response_truncated ? "输出已截断" : job.http_status ? `HTTP ${job.http_status}` : "未收到 HTTP 响应"}</span></div><pre class="audit-body">${escape(body.response?.text ?? (audit.body_pending || job.status === "running" ? "等待响应记录…" : "没有可记录的响应正文。"))}</pre>
      <p class="detail-note">仅显示脱敏后的内容。规则不能识别全部敏感信息，请谨慎分享导出的正文。</p><button class="button" id="export-request"><i data-lucide="download"></i>导出本次脱敏记录</button>`;
  } else if (state.detailTab === "recovery") {
    const chain = audit?.chain ?? [job];
    content = `<p class="detail-note">每次重试创建新请求，保留原记录。服务恢复只标记中断，不会自动重发。</p>
      ${audit?.error ? `<p class="audit-warning">${escape(audit.error)}</p>` : ""}
      <div class="request-chain">${chain.map(item => `<button class="chain-attempt ${item.id === job.id ? "selected" : ""}" data-audit-job="${item.id}"><span class="attempt-index">${item.attempt ?? 1}</span><span><strong>${escape(item.id.slice(0, 8))}</strong><small>${day(item.created_at)} ${time(item.created_at)}</small></span>${badge(item)}<i data-lucide="chevron-right"></i></button>`).join("")}</div>
      ${audit?.retryable ? `<p class="detail-note">恢复来源：${audit.replay_source === "memory" ? "当前进程内存" : "已加密的完整请求记录"}。</p><button class="button primary" id="retry-request"><i data-lucide="rotate-ccw"></i>重试请求</button>` : '<p class="audit-muted">仅最新的失败、中断或已取消请求可重试，并且需要完整请求内容。已成功的链路不会再次恢复。</p>'}`;
  } else {
    const events = job.events?.length ? job.events : [{ type: "accepted", at: job.created_at }];
    content = `<dl class="detail-grid">${fields.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>
      <h3 class="detail-section-title">请求时间线</h3><div class="timeline">${events.map(event => `<div>${escape(eventLabels[event.type] ?? event.type)}${event.related_id ? ` · #${escape(event.related_id.slice(0, 8))}` : ""}<small>${time(event.at)}</small></div>`).join("")}</div>
      <p class="detail-note">${job.status === "interrupted" ? "请求进程已中断，远端可能仍在处理。该状态不代表远端已停止。" : job.status === "cancelled" ? "已停止本地等待，远端可能仍在处理或计费。" : job.body_recording ? "已开启本次请求的脱敏正文记录。" : "本次请求仅记录执行元数据。"}</p>
      ${job.body_log_error ? '<p class="audit-warning">正文记录发生错误，请查看请求状态。响应正文可能未保存完整。</p>' : ""}
      ${job.status === "running" ? '<button class="button task-cancel" id="cancel-task"><i data-lucide="square"></i>停止等待</button>' : ""}`;
  }
  $("detail-content").innerHTML = `<div class="detail-id">${escape(job.id)}</div>
    <div class="detail-status">${badge(job)}<button class="icon-button" id="copy-id" aria-label="复制任务 ID" title="复制任务 ID"><i data-lucide="copy"></i></button></div>
    <div class="audit-tabs" role="tablist" aria-label="请求详情">${[["overview", "概览"], ["exchange", "请求 / 响应"], ["recovery", "恢复链路"]].map(([id, label]) => `<button role="tab" aria-selected="${state.detailTab === id}" class="${state.detailTab === id ? "active" : ""}" data-audit-tab="${id}">${label}</button>`).join("")}<button class="icon-button" id="refresh-audit" title="刷新记录" aria-label="刷新记录"><i data-lucide="refresh-cw"></i></button></div>${content}`;
  icons();
}
async function loadAudit(includeBody = false, force = false) {
  const id = state.selected;
  if (!id || state.auditLoading.has(id) || !window.platformUI?.traceTask) return;
  const job = state.jobs.find(item => item.id === id);
  const old = state.audits.get(id);
  const signature = state.jobs.filter(item => (item.trace_id ?? item.id) === (job?.trace_id ?? id))
    .map(item => `${item.id}:${item.updated_at}:${item.status}`).sort().join("|");
  if (!force && old?.chain_signature === signature && old?.record?.updated_at === job?.updated_at &&
      !old?.body_pending && (!includeBody || old.body_loaded)) return;
  state.auditLoading.add(id);
  try {
    const data = await window.platformUI.traceTask(id, includeBody);
    state.audits.set(id, {
      ...data, body: data.body ?? old?.body, chain_signature: signature,
      body_loaded: includeBody || (old?.body_loaded && old.record?.updated_at === data.record?.updated_at && !old.body_pending)
    });
  } catch (error) { state.audits.set(id, { error: error.message }); }
  finally {
    state.auditLoading.delete(id);
    if ($("detail").open && state.selected === id) renderDetail();
  }
}
function selectRequest(id, tab = "overview") {
  state.selected = id;
  state.detailTab = tab;
  renderDetail();
  if (!$("detail").open) $("detail").showModal();
  if (tab !== "overview") loadAudit(tab === "exchange");
}
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("refresh").disabled = true;
  try {
    const response = await fetch("/api/jobs", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Unavailable");
    const data = await response.json();
    state.jobs = data.jobs;
    state.synced = data.generated_at;
    $("connection").className = "connection connected";
    $("connection-text").textContent = $("auto-refresh").checked ? "本地 · 已连接" : "自动刷新已暂停";
    $("alert").hidden = true;
    render();
    if ($("detail").open && state.detailTab !== "overview") loadAudit(state.detailTab === "exchange");
  } catch {
    $("connection").className = "connection offline";
    $("connection-text").textContent = "连接中断";
    $("alert").hidden = false;
    $("alert").textContent = "无法连接本地监控服务。当前显示上次同步的记录。";
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
  }
}
$("jobs").addEventListener("click", event => {
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  selectRequest(row.dataset.id);
});
$("jobs").addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.target.closest("tr[data-id]")?.click();
  }
});
$("detail-content").addEventListener("click", async event => {
  const tab = event.target.closest("[data-audit-tab]");
  if (tab) {
    state.detailTab = tab.dataset.auditTab;
    renderDetail();
    if (state.detailTab !== "overview") loadAudit(state.detailTab === "exchange");
    return;
  }
  const chainJob = event.target.closest("[data-audit-job]");
  if (chainJob) { selectRequest(chainJob.dataset.auditJob, "recovery"); return; }
  if (event.target.closest("#refresh-audit")) { await loadAudit(state.detailTab === "exchange", true); return; }
  if (event.target.closest("#open-logging")) { window.platformUI?.openLogging(); return; }
  if (event.target.closest("#retry-request")) { window.platformUI?.openRetry(state.selected); return; }
  if (event.target.closest("#export-request")) {
    try {
      const id = state.selected;
      const audit = await window.platformUI.traceTask(id, true);
      if (!audit.body) throw new Error("Body unavailable.");
      const url = URL.createObjectURL(new Blob([JSON.stringify({ record: audit.record, body: audit.body }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `request-${id}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("已导出本次脱敏记录");
    } catch { notify("导出失败，请刷新记录后重试"); }
    return;
  }
  if (event.target.closest("#cancel-task")) {
    try { await window.platformUI?.cancelTask(state.selected); } catch { notify("取消失败，请刷新后重试"); }
    return;
  }
  if (!event.target.closest("#copy-id")) return;
  try { await navigator.clipboard.writeText(state.selected); notify("任务 ID 已复制"); }
  catch { notify("复制失败，可在详情中选择任务 ID"); }
});
document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  render();
}));
for (const id of ["search", "role", "sort", "provider-filter"]) $(id).addEventListener(id === "search" ? "input" : "change", render);
$("refresh").addEventListener("click", refresh);
$("auto-refresh").addEventListener("change", () => {
  if ($("auto-refresh").checked) refresh();
  else $("connection-text").textContent = "自动刷新已暂停";
});
for (const id of ["nav-privacy", "privacy-link"]) $(id).addEventListener("click", () => $("privacy").showModal());
$("nav-tasks").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
$("close-privacy").addEventListener("click", () => $("privacy").close());
$("close-detail").addEventListener("click", () => $("detail").close());
$("export").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/export", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Export failed");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `subtask-monitor-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("已导出脱敏记录");
  } catch { notify("导出失败，请检查本地连接"); }
});
$("date-label").textContent = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long"
}).format(new Date());
new ResizeObserver(drawChart).observe($("activity").parentElement);
setInterval(() => { if ($("auto-refresh").checked && !document.hidden) refresh(); }, 3000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && $("auto-refresh").checked) refresh(); });
icons();
window.monitorAPI = { jobs: () => state.jobs, refresh, render, select: selectRequest };
refresh();
