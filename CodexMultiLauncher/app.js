const state = { profiles: [] };
const collapsedIds = new Set();
const knownProfileIds = new Set();

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function showToast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('toast-error', isError);
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { element.textContent = ''; }, 4200);
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function profileTemplate(profile) {
  const statusLabel = profile.status === 'running' ? `运行中 · PID ${profile.pid}` : profile.status === 'failed' ? '启动失败' : '已停止';
  const tokenLabel = profile.tokenConfigured ? '已保存 Token（留空保持不变）' : '尚未配置 Token';
  const collapsed = collapsedIds.has(profile.id);
  return `<article class="card${collapsed ? ' collapsed' : ''}" data-id="${escapeHtml(profile.id)}">
    <div class="card-head">
      <label class="switch" title="启动/关闭实例"><input class="enabled" type="checkbox" ${profile.status === 'running' ? 'checked' : ''}><span class="slider"></span></label>
      <div class="card-title"><div class="title-row"><strong>${escapeHtml(profile.name)}</strong>${profile.isDefault ? '<span class="default-badge">默认配置（现有配置）</span>' : ''}</div><div class="meta">${escapeHtml(profile.baseUrl)} · ${escapeHtml(profile.model)}</div></div>
      <span class="status ${profile.status}">${statusLabel}</span>
      <button class="button small set-default head-default" type="button" ${profile.isDefault ? 'disabled' : ''}>${profile.isDefault ? '当前默认' : '设为默认'}</button>
      <button class="collapse-toggle" type="button" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? '展开配置' : '折叠配置'}">${collapsed ? '+' : '−'}</button>
    </div>
    <div class="card-body">
      <div class="field"><label>实例名称</label><input class="name" value="${escapeHtml(profile.name)}" placeholder="例如：主账号"></div>
      <div class="field"><label>工作区路径</label><input class="workspace" value="${escapeHtml(profile.workspace)}" placeholder="例如：S:\\P4SilverRoot"></div>
      <div class="field wide"><label>TokenAPI 地址</label><input class="baseUrl" value="${escapeHtml(profile.baseUrl)}" placeholder="https://tokenapi.example.com/v1"></div>
      <div class="field"><label>TokenAPI Token</label><div class="token-row"><input class="token" type="password" placeholder="${tokenLabel}" autocomplete="new-password"><button class="button small toggle-token" type="button">显示</button></div><span class="hint">仅发送到本机服务，并以 Windows DPAPI 加密保存。</span></div>
      <div class="field"><label>模型</label><input class="model" value="${escapeHtml(profile.model)}" placeholder="gpt-6.1-sol"></div>
      <div class="field"><label>推理强度</label><select class="reasoningEffort">${['low','medium','high','xhigh','max','ultra'].map(value => `<option ${value === profile.reasoningEffort ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
      <div class="field"><label>协议</label><select class="wireApi"><option value="responses" ${profile.wireApi === 'responses' ? 'selected' : ''}>responses</option><option value="chat" ${profile.wireApi === 'chat' ? 'selected' : ''}>chat completions</option></select></div>
      <div class="field wide"><label>Codex ChatGPT.exe 路径（可选）</label><input class="executablePath" value="${escapeHtml(profile.executablePath)}" placeholder="留空则自动查找 Microsoft Store 安装"></div>
      <div class="card-actions"><span class="hint">独立目录：${escapeHtml(profile.id)}</span><div class="action-right"><button class="button small save" type="button">保存</button><button class="button small danger delete" type="button">删除</button></div></div>
    </div>
  </article>`;
}

function render() {
  const list = $('#profiles');
  const profileIds = new Set(state.profiles.map(profile => profile.id));
  knownProfileIds.forEach(id => {
    if (!profileIds.has(id)) {
      knownProfileIds.delete(id);
      collapsedIds.delete(id);
    }
  });
  state.profiles.forEach(profile => {
    if (!knownProfileIds.has(profile.id)) {
      knownProfileIds.add(profile.id);
      collapsedIds.add(profile.id);
    }
  });
  list.innerHTML = state.profiles.map(profileTemplate).join('');
  $('#profileCount').textContent = `${state.profiles.length} 个`;
  $('#emptyState').hidden = state.profiles.length !== 0;
  document.querySelectorAll('.card').forEach(bindCard);
  syncToggleAllButton();
}

function collect(card) {
  const value = (selector) => $(selector, card).value.trim();
  return { id: card.dataset.id, name: value('.name'), enabled: $('.enabled', card).checked, workspace: value('.workspace'), baseUrl: value('.baseUrl'), token: $('.token', card).value, model: value('.model'), reasoningEffort: value('.reasoningEffort'), wireApi: value('.wireApi'), executablePath: value('.executablePath') };
}

async function saveCard(card) {
  const button = $('.save', card);
  button.disabled = true;
  try {
    const profile = await request('/api/profiles', { method: 'POST', body: JSON.stringify(collect(card)) });
    showToast('配置已保存');
    return profile;
  } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  return null;
}

function syncToggleAllButton() {
  const button = $('#toggleAll');
  const cards = [...document.querySelectorAll('.card')];
  const allCollapsed = cards.length > 0 && cards.every(card => card.classList.contains('collapsed'));
  button.textContent = allCollapsed ? '全部展开' : '全部折叠';
  button.disabled = cards.length === 0;
}

function setCardCollapsed(card, collapsed) {
  const id = card.dataset.id;
  if (collapsed) collapsedIds.add(id);
  else collapsedIds.delete(id);
  card.classList.toggle('collapsed', collapsed);
  const button = $('.collapse-toggle', card);
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  button.title = collapsed ? '展开配置' : '折叠配置';
  button.textContent = collapsed ? '+' : '−';
  syncToggleAllButton();
}

async function toggleRuntime(card) {
  const toggle = $('.enabled', card);
  const shouldRun = toggle.checked;
  toggle.disabled = true;
  try {
    const profile = await saveCard(card);
    if (!profile) {
      toggle.checked = !shouldRun;
      return;
    }
    const id = encodeURIComponent(profile.id);
    if (shouldRun) {
      await request(`/api/profiles/${id}/launch`, { method: 'POST', body: '{}' });
      showToast('实例启动请求已发送');
    } else {
      await request(`/api/profiles/${id}/stop`, { method: 'POST', body: '{}' });
      showToast('实例停止请求已发送');
    }
    await refresh();
  } catch (error) {
    toggle.checked = !shouldRun;
    showToast(error.message, true);
    await refresh();
  } finally {
    toggle.disabled = false;
  }
}

async function setDefault(card) {
  const button = $('.set-default', card);
  if (button.disabled) return;
  button.disabled = true;
  try {
    await request(`/api/profiles/${encodeURIComponent(card.dataset.id)}/default`, { method: 'POST', body: '{}' });
    showToast('已设为默认配置');
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function bindCard(card) {
  $('.toggle-token', card).addEventListener('click', (event) => { const input = $('.token', card); input.type = input.type === 'password' ? 'text' : 'password'; event.target.textContent = input.type === 'password' ? '显示' : '隐藏'; });
  $('.enabled', card).addEventListener('change', () => toggleRuntime(card));
  $('.collapse-toggle', card).addEventListener('click', () => setCardCollapsed(card, !card.classList.contains('collapsed')));
  $('.set-default', card).addEventListener('click', () => setDefault(card));
  $('.save', card).addEventListener('click', async () => { if (await saveCard(card)) await refresh(); });
  $('.delete', card).addEventListener('click', async () => { if (!window.confirm('删除这个实例配置及其独立目录？')) return; try { await request(`/api/profiles/${encodeURIComponent(card.dataset.id)}`, { method: 'DELETE' }); showToast('实例已删除'); await refresh(); } catch (error) { showToast(error.message, true); } });
}

async function refresh() {
  try { const data = await request('/api/state'); state.profiles = data.profiles; $('#dataRoot').textContent = data.dataRoot; render(); } catch (error) { showToast(error.message, true); }
}

async function addProfile() {
  const name = `实例 ${state.profiles.length + 1}`;
  try { await request('/api/profiles', { method: 'POST', body: JSON.stringify({ name, baseUrl: 'https://tokenapi.happyelements.net/v1', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', wireApi: 'responses', workspace: '', enabled: true }) }); } catch (error) { if (!error.message.includes('工作区不能为空')) showToast(error.message, true); else { /* First save is intentionally blocked until the user fills the workspace. */ } }
  // The API validates a workspace; create a draft locally when there is no valid default.
  if (!state.profiles.some(profile => profile.name === name)) { const draft = { id: `draft-${crypto.randomUUID()}`, name, enabled: true, baseUrl: 'https://tokenapi.happyelements.net/v1', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', wireApi: 'responses', workspace: '', executablePath: '', tokenConfigured: false, status: 'stopped' }; state.profiles.push(draft); render(); }
}

$('#addProfile').addEventListener('click', addProfile); $('#addProfileEmpty').addEventListener('click', addProfile);
$('#importExisting').addEventListener('click', async () => { const button = $('#importExisting'); button.disabled = true; try { const result = await request('/api/import-existing', { method: 'POST', body: '{}' }); if (result.errors?.length) showToast(`已导入 ${result.imported.length} 个，${result.errors.join('；')}`, true); else showToast(`已导入 ${result.imported.length} 个本机配置`); await refresh(); } catch (error) { showToast(error.message, true); } finally { button.disabled = false; } });
$('#launchAll').addEventListener('click', async () => { try { const result = await request('/api/launch-all', { method: 'POST', body: '{}' }); if (result.errors?.length) showToast(`已启动 ${result.started.length} 个，${result.errors.length} 个失败`, true); else showToast(`已同时启动 ${result.started.length} 个实例`); await refresh(); } catch (error) { showToast(error.message, true); } });
$('#stopAll').addEventListener('click', async () => { try { await request('/api/stop-all', { method: 'POST', body: '{}' }); showToast('已发送停止请求'); await refresh(); } catch (error) { showToast(error.message, true); } });
$('#toggleAll').addEventListener('click', () => {
  const cards = [...document.querySelectorAll('.card')];
  if (!cards.length) return;
  const allCollapsed = cards.every(card => card.classList.contains('collapsed'));
  cards.forEach(card => setCardCollapsed(card, !allCollapsed));
});
refresh(); window.setInterval(refresh, 2500);
