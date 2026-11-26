const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
const storedToken = sessionStorage.getItem('fusionToken') || '';
const TOKEN = hashParams.get('token') || storedToken;
if (TOKEN) sessionStorage.setItem('fusionToken', TOKEN);
if (hashParams.get('token')) {
  history.replaceState(null, '', location.pathname + location.search);
}

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));

let app = { omp: null, models: [], connectors: null };
let catalog = { fusion: null, connectors: null };
let memoryState = { thresholdBytes: 0, resetBytes: 0, samples: [] };
let currentAgent = '';
let draft = null;
let baseline = '';
let draftTouched = false;
let ompPrefetch = null;
let activeSnip = 'mcpServers';
let lastSavedAt = '';
let reviewCwd = localStorage.getItem('fusionReviewCwd') || '';
const pickers = new Map();
const roleNodes = new Map();

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const open = document.querySelector('.mp.open');
  if (!open) return;
  event.preventDefault();
  open.classList.remove('open');
  open.querySelector('.mp-trigger')?.focus();
});

let oc = { status: null, draft: null, baseline: '', session: null, models: [] };
let ocCwd = localStorage.getItem('fusionOcCwd') || '';
let ocBusy = false;
const ocPickers = new Map();
const ocRoleNodes = new Map();

function showToast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'toast err' : 'toast';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.className = 'toast hidden';
  }, 3600);
}

async function api(path, body = null) {
  const options = {
    method: body === null ? 'GET' : 'POST',
    headers: {
      'X-Orzic-Token': TOKEN,
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function modelBySelector(selector) {
  if (!selector) return null;
  return app.models.find((model) => model.selector === selector) || null;
}

function updateModelsCount() {
  $('models-count').textContent = `模型目录 · ${app.models.length}`;
}

function formatTokens(value) {
  if (!value) return '';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatCost(value) {
  const number = Number(value || 0);
  if (!number) return '0';
  return number < 1 ? number.toFixed(3) : number.toFixed(2);
}

function costLabel(model) {
  if (!model || (!model.costInput && !model.costOutput)) return '成本未知';
  return `输入 $${formatCost(model.costInput)} / 输出 $${formatCost(model.costOutput)} / 1M`;
}

// ── Navigation ─────────────────────────────────────────────────────────────

const DETAIL_PANELS = { omp: 'tab-omp', opencode: 'tab-opencode', codex: 'tab-codex' };
const DETAIL_SLOTS = { omp: 'omp-mcp', opencode: 'oc-mcp', codex: 'cx-mcp' };
const MEMORY_SLOTS = { omp: 'omp-memory', opencode: 'oc-memory', codex: 'cx-memory' };

function setNav(tabName) {
  document.querySelectorAll('#tabs .tab').forEach((el) => {
    const active = el.dataset.tab === tabName;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

function showPanel(id) {
  document.querySelectorAll('.panel').forEach((el) => {
    el.classList.toggle('active', el.id === id);
  });
}

function showAgentsList(focusId = currentAgent) {
  currentAgent = '';
  setNav('agents');
  showPanel('tab-agents');
  const row = focusId ? document.querySelector(`[data-agent-view="${focusId}"]`) : null;
  if (row) row.focus();
  else $('agents-title').focus();
}

function openAgent(id) {
  const target = catalog.connectors?.targets?.find((item) => item.id === id);
  if (!target) return;
  currentAgent = id;
  setNav('agents');
  const panelId = DETAIL_PANELS[id] || 'tab-agent';
  showPanel(panelId);
  if (panelId === 'tab-agent') {
    $('agent-title').textContent = target.label;
    $('agent-subtitle').textContent = `${target.kind} · 仅支持 MCP 注册；Fusion 不管理它的角色模型或受控会话。`;
    renderMcp('agent-mcp', id);
    renderMemory('agent-memory', id);
    loadMemory();
    $('agent-title').focus();
    return;
  }
  renderMcp(DETAIL_SLOTS[id], id);
  renderMemory(MEMORY_SLOTS[id], id);
  loadMemory();
  $(`${id === 'omp' ? 'omp' : id === 'opencode' ? 'oc' : 'cx'}-title`).focus();
  if (id === 'omp' && !app.omp) loadState();
  if (id === 'opencode' && !oc.status) loadOpenCode(false);
  if (id === 'codex' && !cx.status) loadCodex(false);
}

$('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  currentAgent = '';
  setNav(tab.dataset.tab);
  showPanel(`tab-${tab.dataset.tab}`);
});

document.addEventListener('click', (event) => {
  const windowButton = event.target.closest('[data-window]');
  if (windowButton) {
    api('/api/window', { action: windowButton.dataset.window }).catch(() => {});
    return;
  }
  const handoff = event.target.closest('[data-handoff]');
  if (handoff) {
    copyHandoff(handoff.dataset.handoff);
    return;
  }
  const view = event.target.closest('[data-agent-view]');
  if (view) {
    openAgent(view.dataset.agentView);
    return;
  }
  if (event.target.closest('[data-back]')) {
    showAgentsList();
    return;
  }
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    toggleTarget(toggle.dataset.toggle, toggle.dataset.enable === '1');
    return;
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) removeCustom(remove.dataset.remove);
});

// ── Native window chrome ───────────────────────────────────────────────────

const topbar = document.querySelector('.topbar');
if (topbar) {
  const interactive = (target) =>
    target.closest('button, a, input, textarea, select, .pill');
  topbar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || interactive(event.target)) return;
    api('/api/window', { action: 'drag' }).catch(() => {});
  });
  topbar.addEventListener('dblclick', (event) => {
    if (interactive(event.target)) return;
    api('/api/window', { action: 'maximize' }).catch(() => {});
  });
}

// ── Model picker ────────────────────────────────────────────────────────────

document.addEventListener('click', () => {
  for (const picker of pickers.values()) picker.close();
});

function setRoleModel(role, selector) {
  const entry = draft.roles[role] || (draft.roles[role] = { model: '', thinking: '' });
  draftTouched = true;
  entry.model = selector;
  if (!selector) {
    entry.thinking = '';
  } else {
    const model = modelBySelector(selector);
    if (model && model.reasoning === false) entry.thinking = '';
  }
  const picker = pickers.get(role);
  if (picker) picker.renderValue();
  renderThinking(role);
  renderCost(role);
  updateDirty();
}

function mountPicker(host, role) {
  host.innerHTML = `
    <button type="button" class="mp-trigger">
      <span class="mp-val placeholder"></span>
      <span class="mp-caret" aria-hidden="true"></span>
    </button>
    <div class="mp-pop">
      <div class="mp-search-row">
        <input class="mp-search" type="search" placeholder="搜索模型 / 名称 / provider（空格分词）" />
        <span class="mp-count"></span>
      </div>
      <div class="mp-list"></div>
    </div>`;

  const trigger = host.querySelector('.mp-trigger');
  const valueEl = host.querySelector('.mp-val');
  const searchEl = host.querySelector('.mp-search');
  const countEl = host.querySelector('.mp-count');
  const listEl = host.querySelector('.mp-list');

  const picker = {
    role,
    host,
    renderValue() {
      const selector = draft.roles[role]?.model || '';
      if (!selector) {
        valueEl.className = 'mp-val placeholder';
        valueEl.textContent = '（未设置 / 跟随 OMP 默认）';
        return;
      }
      const model = modelBySelector(selector);
      valueEl.className = 'mp-val';
      valueEl.innerHTML = model
        ? `<span class="mp-name">${esc(model.name)}</span><span class="mp-sel">${esc(model.selector)}</span>`
        : `<span class="mp-name">${esc(selector)}</span>`;
    },
    renderList(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const filtered = terms.length
        ? app.models.filter((model) => {
            const haystack = `${model.selector} ${model.name} ${model.provider}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
          })
        : app.models;
      countEl.textContent = `${filtered.length} / ${app.models.length}`;
      if (!filtered.length) {
        listEl.innerHTML = '<div class="mp-empty">没有匹配的模型</div>';
        return;
      }
      const shown = filtered.slice(0, 300);
      listEl.innerHTML =
        `<button class="mp-item clear" data-sel=""><span class="mi-name">（未设置 / 跟随 OMP 默认）</span></button>` +
        shown
          .map((model) => {
            const cost =
              model.costInput || model.costOutput
                ? `$${formatCost(model.costInput)}/$${formatCost(model.costOutput)}`
                : '';
            return `
          <button class="mp-item" data-sel="${esc(model.selector)}">
            <span class="mi-left">
              <span class="mi-name">${esc(model.name)}</span>
              <span class="mi-sel">${esc(model.selector)}</span>
            </span>
            <span class="mi-tag">${esc(model.provider)}${cost ? ` · ${esc(cost)}` : ''}</span>
          </button>`;
          })
          .join('');
      listEl.querySelectorAll('.mp-item').forEach((item) => {
        item.addEventListener('click', () => {
          setRoleModel(role, item.dataset.sel || '');
          picker.close();
        });
      });
    },
    open() {
      for (const other of pickers.values()) {
        if (other !== picker) other.close();
      }
      host.classList.add('open');
      searchEl.value = '';
      picker.renderList('');
      setTimeout(() => searchEl.focus(), 0);
    },
    close() {
      host.classList.remove('open');
    },
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (host.classList.contains('open')) picker.close();
    else picker.open();
  });
  searchEl.addEventListener('input', () => picker.renderList(searchEl.value));
  host.addEventListener('click', (event) => event.stopPropagation());

  pickers.set(role, picker);
  picker.renderValue();
}

function renderThinking(role) {
  const node = roleNodes.get(role);
  if (!node) return;
  const entry = draft.roles[role] || { model: '', thinking: '' };
  const model = entry.model ? modelBySelector(entry.model) : null;

  if (!entry.model) {
    node.thinkRow.innerHTML = '<span class="think-note">未选择模型时无需设置思考强度。</span>';
    return;
  }
  if (model && model.reasoning === false) {
    node.thinkRow.innerHTML = '<span class="think-note">该模型不支持思考强度。</span>';
    return;
  }

  const declared = !!(model && model.thinking && model.thinking.length);
  const levels = declared ? model.thinking : app.omp.thinkingLevels || [];
  const current = entry.thinking || '';
  const pill = (value, label) =>
    `<button class="pill-btn${current === value ? ' active' : ''}" data-level="${esc(value)}">${esc(label)}</button>`;

  let html =
    '<span class="think-label">思考强度</span>' +
    pill('', `跟随全局 · ${app.omp.defaultThinkingLevel || '默认'}`);
  for (const level of levels) html += pill(level, level);
  if (current && !levels.includes(current)) html += pill(current, current);
  if (model && !declared) {
    html += '<span class="think-note">模型未声明档位，按 OMP 全局档位</span>';
  } else if (!model) {
    html += '<span class="think-note">模型不在目录中，按全局档位</span>';
  }

  node.thinkRow.innerHTML = html;
  node.thinkRow.querySelectorAll('.pill-btn').forEach((button) => {
    button.addEventListener('click', () => {
      entry.thinking = button.dataset.level || '';
      draftTouched = true;
      renderThinking(role);
      updateDirty();
    });
  });
}

function renderCost(role) {
  const node = roleNodes.get(role);
  if (!node) return;
  const model = modelBySelector(draft.roles[role]?.model);
  if (!model) {
    node.costLine.textContent = draft.roles[role]?.model
      ? '模型不在目录中，成本未知'
      : '未选择模型';
    return;
  }
  const context = model.contextWindow ? `上下文 ${formatTokens(model.contextWindow)}` : '';
  node.costLine.textContent = [context, costLabel(model)].filter(Boolean).join(' · ');
}

const DEPARTMENTS = [
  {
    id: 'plan',
    step: '01',
    title: '规划部',
    subtitle: '新愿望先到这里：只读调研、复述目标、产出 PLAN.md',
    roles: ['plan', 'slow'],
  },
  {
    id: 'execute',
    step: '02',
    title: '执行部',
    subtitle: 'PLAN.md 写入后按计划改代码',
    roles: ['default', 'smol'],
  },
  {
    id: 'review',
    step: '03',
    title: '验收部',
    subtitle: 'review / advisor 角色独立配置；自动验收可按工作区开启',
    roles: ['review', 'advisor'],
  },
];

function buildRoleCard(role) {
  const card = document.createElement('div');
  card.className = 'role-card';
  card.dataset.role = role.role;
  card.innerHTML = `
    <div class="role-head">
      <div>
        <div class="role-name">${esc(role.label)}<span class="role-key">${esc(role.role)}</span></div>
        <div class="role-desc">${esc(role.description)}</div>
      </div>
      <div class="role-raw${role.raw ? '' : ' unset'}" title="OMP modelRoles.${esc(role.role)}">${esc(role.raw || '未设置')}</div>
    </div>
    <div class="mp"></div>
    <div class="think-row"></div>
    <div class="cost-line"></div>`;
  const thinkRow = card.querySelector('.think-row');
  const costLine = card.querySelector('.cost-line');
  roleNodes.set(role.role, { card, thinkRow, costLine });
  mountPicker(card.querySelector('.mp'), role.role);
  renderThinking(role.role);
  renderCost(role.role);
  return card;
}

function buildDepartment(dept, roles) {
  const section = document.createElement('section');
  section.className = 'department';
  section.dataset.dept = dept.id;
  section.innerHTML = `
    <div class="dept-head">
      <div class="dept-title"><span class="dept-step">${esc(dept.step)}</span>${esc(dept.title)}</div>
      <div class="dept-sub">${esc(dept.subtitle)}</div>
    </div>
    <div class="dept-roles"></div>`;
  const grid = section.querySelector('.dept-roles');
  for (const role of roles) grid.appendChild(buildRoleCard(role));
  if (dept.id === 'review') section.appendChild(buildReviewBox());
  return section;
}

function buildReviewBox() {
  const box = document.createElement('div');
  box.className = 'review-box';
  box.innerHTML = `
    <div class="review-head">
      <div>
        <div class="review-title">验收</div>
        <div class="muted">收集工作区 diff + PLAN.md；手动运行，或按工作区自动验收</div>
      </div>
      <button id="btn-review" class="btn primary small">运行验收</button>
    </div>
    <label class="review-cwd">
      <span>工作区路径</span>
      <input id="review-cwd" type="text" placeholder="C:\\path\\to\\repo" />
    </label>
    <div class="review-auto">
      <label class="chk"><input type="checkbox" id="auto-enabled" /> 自动验收此工作区</label>
      <label class="chk"><input type="checkbox" id="auto-rework" /> REWORK 自动回喂（最多 2 轮）</label>
    </div>
    <div class="muted hint" id="auto-hint"></div>
    <div id="review-result" class="review-result"></div>`;
  const input = box.querySelector('#review-cwd');
  input.value = reviewCwd;
  input.addEventListener('input', () => {
    reviewCwd = input.value;
    localStorage.setItem('fusionReviewCwd', reviewCwd);
    syncReviewAuto(box);
  });
  const autoEnabled = box.querySelector('#auto-enabled');
  const autoRework = box.querySelector('#auto-rework');
  autoEnabled.addEventListener('change', () => {
    if (!autoEnabled.checked) autoRework.checked = false;
    saveAuto(autoEnabled.checked, autoRework.checked);
  });
  autoRework.addEventListener('change', () => {
    if (autoRework.checked) autoEnabled.checked = true;
    saveAuto(autoEnabled.checked, autoRework.checked);
  });
  box.querySelector('#btn-review').addEventListener('click', runAcceptance);
  renderReviewResult(box);
  syncReviewAuto(box);
  return box;
}

function normalizeCwd(value) {
  let text = String(value || '').trim().replace(/\//g, '\\');
  while (text.length > 3 && text.endsWith('\\')) text = text.slice(0, -1);
  return text.toLowerCase();
}

function autoFor(cwd) {
  const map = app.acceptance?.auto?.workspaces || {};
  return map[normalizeCwd(cwd)] || { enabled: false, rework: false };
}

function syncReviewAuto(root = document) {
  const enabled = root.querySelector('#auto-enabled');
  const rework = root.querySelector('#auto-rework');
  const hint = root.querySelector('#auto-hint');
  if (!enabled || !rework) return;
  const cwd = (root.querySelector('#review-cwd')?.value || reviewCwd).trim();
  const settings = autoFor(cwd);
  enabled.checked = !!settings.enabled;
  rework.checked = !!settings.rework && !!settings.enabled;
  enabled.disabled = !cwd;
  rework.disabled = !cwd || !enabled.checked;
  if (hint) {
    hint.textContent = !cwd
      ? '先填写工作区路径，再开启自动验收。'
      : settings.enabled
        ? settings.rework
          ? '已开启：执行回合结束后自动验收；REWORK 自动回喂原会话，最多 2 轮。'
          : '已开启：执行回合结束后自动验收；REWORK 只显示，不回喂。'
        : '自动验收默认关闭；只在主执行回合结束且工作区有可归属改动时运行。';
  }
}

async function saveAuto(enabled, rework) {
  const cwd = ($('review-cwd')?.value || reviewCwd).trim();
  if (!cwd) {
    showToast('请先填写工作区路径', true);
    syncReviewAuto();
    return;
  }
  try {
    const data = await api('/api/acceptance/auto', {
      cwd,
      enabled,
      rework: enabled && rework,
    });
    app.acceptance = app.acceptance || {};
    app.acceptance.auto = data.auto;
    showToast(
      enabled
        ? rework
          ? '自动验收与回喂已开启'
          : '自动验收已开启'
        : '自动验收已关闭'
    );
  } catch (error) {
    showToast(error.message, true);
  }
  syncReviewAuto();
}

function renderReviewResult(root = document) {
  const host = root.querySelector('#review-result');
  if (!host) return;
  const result = app.acceptance?.last;
  if (!result || !result.verdict) {
    host.innerHTML = '<span class="muted">尚未运行</span>';
    return;
  }
  const verdict = String(result.verdict).toLowerCase();
  const label = verdict === 'pass' ? 'PASS' : verdict === 'rework' ? 'REWORK' : verdict === 'skip' ? 'SKIP' : verdict === 'stale' ? 'STALE' : 'FAILED';
  const meta = [];
  if (result.mode === 'auto') meta.push('自动');
  else if (result.mode === 'manual') meta.push('手动');
  if (result.model) meta.push(result.model);
  if (result.thinking) meta.push(`thinking ${result.thinking}`);
  if (result.files) meta.push(`${result.files} 个文件`);
  if (result.diffChars) meta.push(`${result.diffChars} 字符`);
  if (result.durationMs) meta.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.at) meta.push(new Date(result.at).toLocaleString('zh-CN', { hour12: false }));
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const summary = result.reason || result.summary || '';
  host.innerHTML = `
    <div><span class="verdict ${verdict}">${label}</span> <span class="review-meta">${esc(meta.join(' · '))}</span></div>
    ${summary ? `<div class="review-summary">${esc(summary)}</div>` : ''}
    ${findings.length ? `<ul class="review-findings">${findings.slice(0, 20).map((finding) => `<li><b>${esc(finding.severity || 'info')}</b> ${esc(finding.file || '')}${finding.line ? `:${finding.line}` : ''} — ${esc(finding.message || '')}</li>`).join('')}</ul>` : ''}`;
}

async function runAcceptance() {
  const input = $('review-cwd');
  const cwd = (input?.value || reviewCwd).trim();
  if (!cwd) {
    showToast('请填写工作区路径', true);
    return;
  }
  reviewCwd = cwd;
  localStorage.setItem('fusionReviewCwd', cwd);
  const button = $('btn-review');
  button.disabled = true;
  button.textContent = '验收中…';
  const host = $('review-result');
  if (host) host.innerHTML = '<span class="muted">正在收集 diff 并调用 review 模型…</span>';
  try {
    const result = await api('/api/acceptance/run', { cwd });
    app.acceptance = app.acceptance || {};
    app.acceptance.last = result;
    app.acceptance.cwd = result.cwd || cwd;
    renderReviewResult();
    showToast(
      result.verdict === 'pass'
        ? '验收通过'
        : result.verdict === 'rework'
          ? '验收需要返工'
          : result.verdict === 'skip'
            ? '没有可验收的改动'
            : '验收完成'
    );
  } catch (error) {
    if (host) host.innerHTML = `<span class="verdict failed">FAILED</span> <span class="review-meta">${esc(error.message)}</span>`;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '运行验收';
  }
}

function renderRoles() {
  const host = $('departments');
  host.innerHTML = '';
  pickers.clear();
  roleNodes.clear();

  const byRole = new Map(app.omp.roles.map((role) => [role.role, role]));
  const used = new Set();
  for (const dept of DEPARTMENTS) {
    const roles = dept.roles.map((name) => byRole.get(name)).filter(Boolean);
    for (const role of roles) used.add(role.role);
    if (roles.length) host.appendChild(buildDepartment(dept, roles));
  }

  const extras = app.omp.roles.filter((role) => !used.has(role.role));
  if (extras.length) {
    host.appendChild(
      buildDepartment(
        {
          id: 'custom',
          step: '＋',
          title: '自定义角色',
          subtitle: 'OMP 中已有的其他模型角色，原样保留',
        },
        extras
      )
    );
  }
}

// ── Flags ───────────────────────────────────────────────────────────────────

function renderFlags() {
  $('flag-plan').checked = !!draft.flags.planEnabled;
  $('flag-advisor').checked = !!draft.flags.advisorEnabled;
  $('flag-prewalk').checked = !!draft.flags.taskPrewalk;

  const select = $('default-thinking');
  select.innerHTML = (app.omp.thinkingLevels || [])
    .map((level) => `<option value="${esc(level)}">${esc(level)}</option>`)
    .join('');
  select.value = draft.defaultThinkingLevel || 'high';
}

$('flag-plan').addEventListener('change', () => {
  draft.flags.planEnabled = $('flag-plan').checked;
  draftTouched = true;
  updateDirty();
});
$('flag-advisor').addEventListener('change', () => {
  draft.flags.advisorEnabled = $('flag-advisor').checked;
  draftTouched = true;
  updateDirty();
});
$('flag-prewalk').addEventListener('change', () => {
  draft.flags.taskPrewalk = $('flag-prewalk').checked;
  draftTouched = true;
  updateDirty();
});
$('default-thinking').addEventListener('change', () => {
  draft.defaultThinkingLevel = $('default-thinking').value;
  draftTouched = true;
  updateDirty();
});

function updateDirty() {
  const dirty = JSON.stringify(draft) !== baseline;
  const hint = $('dirty-hint');
  if (dirty) {
    hint.textContent = '有未保存修改';
    hint.classList.add('dirty');
    hint.classList.remove('saved');
  } else if (lastSavedAt) {
    hint.textContent = `已保存到 OMP · ${lastSavedAt}`;
    hint.classList.add('saved');
    hint.classList.remove('dirty');
  } else {
    hint.textContent = '已同步';
    hint.classList.remove('dirty', 'saved');
  }
  $('btn-save').disabled = !dirty;
  $('btn-save').textContent = dirty ? '保存到 OMP' : lastSavedAt ? '已保存' : '已同步';
}

// ── Connectors ──────────────────────────────────────────────────────────────

function statusPill(target) {
  if (target.error) return '<span class="pill err">配置错误</span>';
  if (target.connected) return '<span class="pill ok">已注册</span>';
  if (target.detected) return '<span class="pill warn">未注册</span>';
  return '<span class="pill">未检测</span>';
}

function capabilityLabel(target) {
  const caps = target.capabilities || [];
  return caps.length ? caps.join(' · ') : '仅 MCP 注册';
}

function renderAgents() {
  const connectors = catalog.connectors;
  if (!connectors) return;
  $('conn-server').textContent = `服务名 · ${connectors.serverName}`;
  const list = $('agents-list');
  list.innerHTML = connectors.targets
    .map(
      (target) => `
        <div class="target agent-row">
          <div class="target-top">
            <div>
              <div class="target-name">${esc(target.label)}</div>
              <div class="target-kind">${esc(target.kind)}</div>
              <div class="agent-caps">${esc(capabilityLabel(target))}</div>
            </div>
          </div>
          <div class="target-actions">
            ${statusPill(target)}
            <button class="btn small" data-agent-view="${esc(target.id)}">查看配置</button>
          </div>
        </div>`
    )
    .join('');
}

function renderMcp(slotId, targetId) {
  const slot = $(slotId);
  if (!slot) return;
  const target = catalog.connectors?.targets?.find((item) => item.id === targetId);
  if (!target) {
    slot.innerHTML = '<div class="card"><div class="muted">未找到该目标，返回列表重新选择。</div></div>';
    return;
  }
  const disabled = !target.detected && !target.custom ? 'disabled' : '';
  slot.innerHTML = `
    <div class="card mcp-card">
      <div class="card-head">
        <div>
          <div class="card-title">MCP 注册</div>
          <div class="muted">写入前自动备份原配置，只合并 <code>mcpServers</code> 条目；已注册不代表当前会话已加载。</div>
        </div>
        ${statusPill(target)}
      </div>
      <div class="kv">
        ${kvRow('配置文件', target.configPath || '')}
        ${kvRow('配置格式', target.format || '')}
        ${target.error ? kvRow('错误', target.error, 'err') : ''}
      </div>
      <div class="row-end">
        ${target.custom ? `<button class="btn ghost small" data-remove="${esc(target.id)}">移除记录</button>` : ''}
        <button class="btn small ${target.connected ? 'danger' : 'primary'}"
          data-toggle="${esc(target.id)}" data-enable="${target.connected ? '0' : '1'}" ${disabled}>
          ${target.connected ? '取消注册 MCP' : '注册 MCP'}
        </button>
      </div>
    </div>`;
}

function renderActiveMcp() {
  if (!currentAgent) return;
  renderMcp(DETAIL_SLOTS[currentAgent] || 'agent-mcp', currentAgent);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function memoryTarget(agentId) {
  return catalog.connectors?.targets?.find((target) => target.id === agentId) || null;
}

function agentSamples(agentId) {
  return (memoryState.samples || []).filter((sample) => sample.agent === agentId);
}

function renderMemory(slotId, agentId) {
  const slot = $(slotId);
  if (!slot) return;
  const target = memoryTarget(agentId);
  const samples = agentSamples(agentId);
  const warned = samples.some((sample) => sample.alerted);
  const threshold = memoryState.thresholdBytes
    ? formatBytes(memoryState.thresholdBytes)
    : '1.75 GB';
  const blocks = samples
    .map(
      (sample) => `
        <div class="memory-sample">
          <div class="memory-sample-title">${esc(sample.sessionId || '未命名')} · ${esc(sample.phase || '阶段未上报')}</div>
          <div class="kv">
            ${kvRow('工作区', sample.cwd || '—')}
            ${kvRow('内存', formatBytes(sample.rssBytes), sample.alerted ? 'err' : '')}
            ${kvRow(
              '采样',
              `${new Date(sample.sampledAt).toLocaleTimeString('zh-CN', { hour12: false })} · ${sample.scope === 'process' ? '进程级' : '本次运行'}`
            )}
            ${sample.note ? kvRow('说明', sample.note) : ''}
          </div>
        </div>`
    )
    .join('');
  const empty = target?.capabilities?.length
    ? '未观测到该 Agent 的会话。OMP 由扩展上报；OpenCode / Codex 只在 Fusion 启动的运行期间显示。'
    : '该客户端未提供会话归属，只能管理 MCP 注册。';
  slot.innerHTML = `
    <div class="card memory-card">
      <div class="card-head">
        <div>
          <div class="card-title">会话资源</div>
          <div class="muted">本机进程常驻内存（RSS / Windows Working Set）· 预警 ${threshold} · 每 5 秒刷新</div>
        </div>
        ${samples.length ? `<span class="pill ${warned ? 'err' : 'ok'}">${warned ? '超过预警' : '正常'}</span>` : '<span class="pill">未观测</span>'}
      </div>
      ${samples.length ? `<div class="memory-samples">${blocks}</div>` : `<div class="muted">${empty}</div>`}
      ${warned ? '<div class="memory-alert">已超过预警线：先整理进度再开新对话（/new，旧会话保留）；新对话不保证释放进程内存，也不会上报服务器端模型的上下文用量。</div>' : ''}
      ${samples.length ? '<div class="row-end"><button class="btn small" data-handoff="' + esc(agentId) + '">复制交接提纲</button></div>' : ''}
    </div>`;
}

async function loadMemory() {
  try {
    memoryState = await api('/api/session-memory');
  } catch {
    return;
  }
  if (!currentAgent) return;
  const slot = MEMORY_SLOTS[currentAgent] || 'agent-memory';
  renderMemory(slot, currentAgent);
}

async function copyHandoff(agentId) {
  const target = memoryTarget(agentId);
  const sample = agentSamples(agentId)[0];
  if (!sample) return;
  const text = [
    'Orzic Fusion 交接提纲',
    `Agent：${target?.label || agentId}`,
    `会话：${sample.sessionId || '未命名'}`,
    `工作区：${sample.cwd || '（未上报）'}`,
    `阶段：${sample.phase || '（未上报）'}`,
    `内存：${formatBytes(sample.rssBytes)}（进程常驻）· ${new Date(sample.sampledAt).toLocaleString('zh-CN')}`,
    '',
    '目标：',
    '已完成：',
    '未完成：',
    '关键决策：',
    '关键文件：',
    '下一步：',
    '',
    '说明：由 Fusion 生成；粘贴到新对话后补全空白。旧会话保留，不会被自动删除。',
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('交接提纲已复制');
  } catch {
    showToast('复制失败，请手动选择文本', true);
  }
}

function renderSnippet() {
  const snippets = catalog.connectors?.snippets || {};
  $('snippet-code').textContent = snippets[activeSnip] || '';
  document.querySelectorAll('#snippet-tabs .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.snip === activeSnip);
  });
}

$('snippet-tabs').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  activeSnip = chip.dataset.snip;
  renderSnippet();
});

function applyCatalog(data) {
  catalog = data;
  const fusion = catalog.fusion || {};
  const pill = $('pill-fusion');
  pill.textContent = `Fusion · ${fusion.version || '未检测到'}`;
  pill.className = `pill ${fusion.version ? 'ok' : 'err'}`;
  $('conn-server').textContent = `服务名 · ${catalog.connectors?.serverName || 'fusion'}`;
  renderAgents();
  renderActiveMcp();
  renderSnippet();
  renderOverview();
}

async function loadCatalog() {
  try {
    applyCatalog(await api('/api/agents'));
  } catch (error) {
    showToast(`Agent 目录加载失败：${error.message}`, true);
  }
}

async function toggleTarget(id, enable) {
  try {
    applyCatalog(await api('/api/connectors/toggle', { id, enable }));
    showToast(enable ? '已注册 fusion MCP' : '已取消注册 fusion MCP');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function removeCustom(id) {
  try {
    applyCatalog(await api('/api/connectors/remove-custom', { id }));
    showToast('已移除记录（未改动原配置文件）');
    if (currentAgent === id) showAgentsList();
  } catch (error) {
    showToast(error.message, true);
  }
}

$('btn-connect-custom').addEventListener('click', async () => {
  const path = $('custom-path').value.trim();
  const label = $('custom-label').value.trim();
  if (!path) {
    showToast('请输入配置文件路径', true);
    return;
  }
  try {
    applyCatalog(await api('/api/connectors/custom', { customPath: path, label, enable: true }));
    $('custom-path').value = '';
    $('custom-label').value = '';
    showToast('已接入自定义配置');
  } catch (error) {
    showToast(error.message, true);
  }
});

$('btn-copy-snippet').addEventListener('click', async () => {
  const text = $('snippet-code').textContent;
  try {
    await navigator.clipboard.writeText(text);
    showToast('片段已复制');
  } catch {
    showToast('复制失败，请手动选择文本', true);
  }
});

// ── OpenCode ────────────────────────────────────────────────────────────────

function ocModelBySelector(selector) {
  if (!selector) return null;
  return (oc.models || []).find((model) => model.selector === selector) || null;
}

function ocRoleRaw(role) {
  const entry = oc.draft?.roles?.[role];
  if (!entry || !entry.model) return '';
  return entry.variant ? `${entry.model}#${entry.variant}` : entry.model;
}

function ocUpdateDirty() {
  if (!oc.draft) return;
  const dirty = JSON.stringify(oc.draft) !== oc.baseline;
  const hint = $('oc-dirty-hint');
  if (dirty) {
    hint.textContent = '有未保存修改';
    hint.classList.add('dirty');
    hint.classList.remove('saved');
  } else {
    hint.textContent = '已同步';
    hint.classList.remove('dirty', 'saved');
  }
  $('oc-save').disabled = !dirty || ocBusy;
  $('oc-save').textContent = dirty ? '保存到 Fusion' : '已同步';
}

function renderOcEnv() {
  const status = oc.status;
  if (!status) return;
  const connector = status.connector || {};
  $('oc-version').textContent = `OpenCode · ${(status.version || '未检测到').replace(/^opencode\s+/i, '')}`;
  $('oc-version').className = `pill ${status.version ? 'ok' : 'err'}`;
  $('oc-env').innerHTML = [
    kvRow('可执行文件', status.executable || '未检测到', status.executable ? 'ok' : 'err'),
    kvRow('版本', status.version || '未检测到', status.version ? 'ok' : 'err'),
    kvRow('配置文件', status.configPath || ''),
    ...(status.jsoncExists ? [kvRow('配置提示', '存在 JSONC，只读', 'warn')] : []),
    kvRow('验收 agent', status.reviewAgentReady ? '就绪' : '首次验收时创建'),
    kvRow('模型目录', `${(oc.models || []).length} 个`),
  ].join('');
  $('oc-models-count').textContent = `模型目录 · ${(oc.models || []).length}`;
  const errorCard = $('oc-error');
  const message = status.modelError || connector.error || '';
  if (message) {
    errorCard.textContent = message;
    errorCard.classList.remove('hidden');
  } else {
    errorCard.classList.add('hidden');
  }
}

function renderOcRaw(role) {
  const node = ocRoleNodes.get(role);
  if (!node) return;
  const raw = ocRoleRaw(role);
  node.raw.textContent = raw || '未设置';
  node.raw.className = `role-raw${raw ? '' : ' unset'}`;
}

function renderOcVariants(role) {
  const node = ocRoleNodes.get(role);
  if (!node) return;
  const entry = oc.draft?.roles?.[role] || { model: '', variant: '' };
  const model = ocModelBySelector(entry.model);
  if (!entry.model) {
    node.thinkRow.innerHTML = '<span class="think-note">未选择模型时使用 OpenCode 默认档位。</span>';
    return;
  }
  if (!model) {
    node.thinkRow.innerHTML = '<span class="think-note">模型不在当前目录中，保存前请重新选择。</span>';
    return;
  }
  if (!model.variants.length) {
    node.thinkRow.innerHTML = '<span class="think-note">该模型未声明 variant，使用模型默认档。</span>';
    return;
  }
  const current = entry.variant || '';
  const pill = (value, label) =>
    `<button class="pill-btn${current === value ? ' active' : ''}" data-variant="${esc(value)}">${esc(label)}</button>`;
  node.thinkRow.innerHTML =
    '<span class="think-label">Variant</span>' +
    pill('', '默认') +
    model.variants.map((variant) => pill(variant, variant)).join('');
  node.thinkRow.querySelectorAll('.pill-btn').forEach((button) => {
    button.addEventListener('click', () => {
      entry.variant = button.dataset.variant || '';
      renderOcVariants(role);
      renderOcRaw(role);
      renderOcCost(role);
      ocUpdateDirty();
    });
  });
}

function renderOcCost(role) {
  const node = ocRoleNodes.get(role);
  if (!node) return;
  const entry = oc.draft?.roles?.[role];
  const model = ocModelBySelector(entry?.model);
  if (!model) {
    node.costLine.textContent = entry?.model ? '模型不在目录中，成本未知' : '未选择模型';
    return;
  }
  const context = model.contextWindow ? `上下文 ${formatTokens(model.contextWindow)}` : '';
  const cost =
    model.costInput || model.costOutput
      ? `输入 $${formatCost(model.costInput)} / 输出 $${formatCost(model.costOutput)} / 1M`
      : '成本未知';
  node.costLine.textContent = [context, cost].filter(Boolean).join(' · ');
}

function setOcRoleModel(role, selector) {
  const entry = oc.draft.roles[role] || (oc.draft.roles[role] = { model: '', variant: '' });
  entry.model = selector;
  if (!selector) {
    entry.variant = '';
  } else {
    const model = ocModelBySelector(selector);
    if (!model || !model.variants.includes(entry.variant)) entry.variant = '';
  }
  const picker = ocPickers.get(role);
  if (picker) picker.renderValue();
  renderOcRaw(role);
  renderOcVariants(role);
  renderOcCost(role);
  ocUpdateDirty();
}

function mountOcPicker(host, role) {
  host.innerHTML = `
    <button type="button" class="mp-trigger">
      <span class="mp-val placeholder"></span>
      <span class="mp-caret" aria-hidden="true"></span>
    </button>
    <div class="mp-pop">
      <div class="mp-search-row">
        <input class="mp-search" type="search" placeholder="搜索模型 / 名称 / provider（空格分词）" />
        <span class="mp-count"></span>
      </div>
      <div class="mp-list"></div>
    </div>`;

  const trigger = host.querySelector('.mp-trigger');
  const valueEl = host.querySelector('.mp-val');
  const searchEl = host.querySelector('.mp-search');
  const countEl = host.querySelector('.mp-count');
  const listEl = host.querySelector('.mp-list');

  const picker = {
    role,
    host,
    renderValue() {
      const selector = oc.draft.roles[role]?.model || '';
      if (!selector) {
        valueEl.className = 'mp-val placeholder';
        valueEl.textContent = '（未设置 / 使用 OpenCode 默认）';
        return;
      }
      const model = ocModelBySelector(selector);
      valueEl.className = 'mp-val';
      valueEl.innerHTML = model
        ? `<span class="mp-name">${esc(model.name)}</span><span class="mp-sel">${esc(model.selector)}</span>`
        : `<span class="mp-name">${esc(selector)}</span>`;
    },
    renderList(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const models = oc.models || [];
      const filtered = terms.length
        ? models.filter((model) => {
            const haystack = `${model.selector} ${model.name} ${model.provider}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
          })
        : models;
      countEl.textContent = `${filtered.length} / ${models.length}`;
      if (!filtered.length) {
        listEl.innerHTML = '<div class="mp-empty">没有匹配的模型</div>';
        return;
      }
      const shown = filtered.slice(0, 300);
      listEl.innerHTML =
        '<button class="mp-item clear" data-sel=""><span class="mi-name">（未设置 / 使用 OpenCode 默认）</span></button>' +
        shown
          .map(
            (model) => `
          <button class="mp-item" data-sel="${esc(model.selector)}">
            <span class="mi-left">
              <span class="mi-name">${esc(model.name)}</span>
              <span class="mi-sel">${esc(model.selector)}</span>
            </span>
            <span class="mi-tag">${esc(model.provider)}${model.variants.length ? ` · ${model.variants.length} 档` : ''}</span>
          </button>`
          )
          .join('');
      listEl.querySelectorAll('.mp-item').forEach((item) => {
        item.addEventListener('click', () => {
          setOcRoleModel(role, item.dataset.sel || '');
          picker.close();
        });
      });
    },
    open() {
      for (const other of ocPickers.values()) {
        if (other !== picker) other.close();
      }
      host.classList.add('open');
      searchEl.value = '';
      picker.renderList('');
      setTimeout(() => searchEl.focus(), 0);
    },
    close() {
      host.classList.remove('open');
    },
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (host.classList.contains('open')) picker.close();
    else picker.open();
  });
  searchEl.addEventListener('input', () => picker.renderList(searchEl.value));
  host.addEventListener('click', (event) => event.stopPropagation());
  ocPickers.set(role, picker);
  picker.renderValue();
}

function renderOcRoles() {
  const host = $('oc-roles');
  if (!host) return;
  host.innerHTML = '';
  ocPickers.clear();
  ocRoleNodes.clear();
  if (!oc.draft) return;
  for (const role of oc.status?.roles || []) {
    const card = document.createElement('div');
    card.className = 'role-card';
    card.dataset.role = role.role;
    card.innerHTML = `
      <div class="role-head">
        <div>
          <div class="role-name">${esc(role.label)}<span class="role-key">${esc(role.role)}</span></div>
          <div class="role-desc">${esc(role.description)}</div>
        </div>
        <div class="role-raw unset" title="OpenCode ${esc(role.role)}">未设置</div>
      </div>
      <div class="mp"></div>
      <div class="think-row"></div>
      <div class="cost-line"></div>`;
    ocRoleNodes.set(role.role, {
      card,
      raw: card.querySelector('.role-raw'),
      thinkRow: card.querySelector('.think-row'),
      costLine: card.querySelector('.cost-line'),
    });
    mountOcPicker(card.querySelector('.mp'), role.role);
    renderOcRaw(role.role);
    renderOcVariants(role.role);
    renderOcCost(role.role);
    host.appendChild(card);
  }
}

function renderOcReview() {
  const host = $('oc-review-result');
  if (!host) return;
  const result = oc.status?.review;
  if (!result || !result.verdict) {
    host.innerHTML = '<span class="muted">尚未运行</span>';
    return;
  }
  const verdict = String(result.verdict).toLowerCase();
  const label =
    verdict === 'pass'
      ? 'PASS'
      : verdict === 'rework'
        ? 'REWORK'
        : verdict === 'skip'
          ? 'SKIP'
          : 'FAILED';
  const meta = [];
  if (result.host) meta.push(result.host);
  if (result.model) meta.push(result.model);
  if (result.variant) meta.push(`variant ${result.variant}`);
  if (result.files) meta.push(`${result.files} 个文件`);
  if (result.diffChars) meta.push(`${result.diffChars} 字符`);
  if (result.durationMs) meta.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.at) meta.push(new Date(result.at).toLocaleString('zh-CN', { hour12: false }));
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const summary = result.summary || '';
  host.innerHTML = `
    <div><span class="verdict ${verdict}">${label}</span> <span class="review-meta">${esc(meta.join(' · '))}</span></div>
    ${summary ? `<div class="review-summary">${esc(summary)}</div>` : ''}
    ${findings.length ? `<ul class="review-findings">${findings.slice(0, 20).map((finding) => `<li><b>${esc(finding.severity || 'info')}</b> ${esc(finding.file || '')}${finding.line ? `:${finding.line}` : ''} — ${esc(finding.message || '')}</li>`).join('')}</ul>` : ''}`;
}

function renderOcSession() {
  const session = oc.session;
  const phase = session?.phase || '';
  const pill = $('oc-session-pill');
  if (pill) {
    pill.textContent = phase === 'planned' ? '待确认' : phase === 'executed' ? '已执行' : '未开始';
    pill.className = `pill ${phase === 'planned' ? 'warn' : phase === 'executed' ? 'ok' : ''}`;
  }
  $('oc-plan-output').textContent = session?.plan || '尚未开始';
  $('oc-exec-output').textContent = session?.execution || '尚未执行';
  if (session?.task && !$('oc-task').value) $('oc-task').value = session.task;
  const cwd = ($('oc-cwd').value || ocCwd).trim();
  const task = $('oc-task').value.trim();
  $('oc-plan').disabled = ocBusy || !cwd || !task;
  $('oc-execute').disabled = ocBusy || !session || session.phase !== 'planned';
  $('oc-review').disabled = ocBusy || !session || session.phase !== 'executed';
  $('oc-reset-session').disabled = ocBusy || !session;
  $('oc-session-status').textContent = session
    ? `会话 ${session.id} · 规划 ${session.planModel || '—'}${session.planVariant ? `#${session.planVariant}` : ''}${session.executionModel ? ` · 执行 ${session.executionModel}${session.executionVariant ? `#${session.executionVariant}` : ''}` : ''}`
    : '填写工作区与任务后开始规划；规划确认前不会进入执行。';
  renderOcReview();
}

function applyOcStatus(status) {
  oc.status = status;
  oc.models = status.models || [];
  oc.session = status.session || null;
  if (status.cwd) {
    ocCwd = status.cwd;
    localStorage.setItem('fusionOcCwd', ocCwd);
  }
  const cwdInput = $('oc-cwd');
  if (cwdInput && !cwdInput.value) cwdInput.value = ocCwd;
  oc.draft = { roles: {} };
  for (const role of status.roles || []) {
    oc.draft.roles[role.role] = { model: role.model || '', variant: role.variant || '' };
  }
  oc.baseline = JSON.stringify(oc.draft);
  renderOcEnv();
  renderOcRoles();
  renderOcSession();
  ocUpdateDirty();
}

async function loadOpenCode(force = false) {
  const cwd = ($('oc-cwd')?.value || ocCwd).trim();
  try {
    const status = await api('/api/opencode', { cwd, force });
    applyOcStatus(status);
  } catch (error) {
    showToast(`OpenCode 读取失败：${error.message}`, true);
    const card = $('oc-error');
    if (card) {
      card.textContent = error.message;
      card.classList.remove('hidden');
    }
  }
}

async function saveOpenCode() {
  if (!oc.draft) return;
  $('oc-save').disabled = true;
  try {
    const status = await api('/api/opencode/save', {
      cwd: ($('oc-cwd').value || ocCwd).trim(),
      roles: oc.draft.roles,
    });
    applyOcStatus(status);
    showToast('OpenCode 角色模型已保存');
  } catch (error) {
    showToast(error.message, true);
    ocUpdateDirty();
  }
}

async function runOcSession(action, extra = {}) {
  if (ocBusy) return;
  const cwd = ($('oc-cwd').value || ocCwd).trim();
  if (!cwd) {
    showToast('请填写工作区路径', true);
    return;
  }
  ocBusy = true;
  renderOcSession();
  $('oc-session-status').textContent =
    action === 'plan'
      ? '规划中…'
      : action === 'execute'
        ? '执行中…'
        : action === 'review'
          ? '验收中…'
          : '正在清除会话…';
  try {
    const status = await api('/api/opencode/session', { action, cwd, ...extra });
    ocBusy = false;
    applyOcStatus(status);
    showToast(
      action === 'plan'
        ? '规划完成；确认后再执行'
        : action === 'execute'
          ? '执行完成；可运行验收'
          : action === 'review'
            ? '验收完成'
            : '会话已清除'
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    ocBusy = false;
    renderOcSession();
    setTimeout(renderOcSession, 0);
  }
}

$('oc-cwd').value = ocCwd;
$('oc-cwd').addEventListener('input', () => {
  ocCwd = $('oc-cwd').value;
  localStorage.setItem('fusionOcCwd', ocCwd);
  renderOcSession();
});
$('oc-cwd').addEventListener('change', () => {
  if ($('tab-opencode').classList.contains('active')) loadOpenCode(false);
});
$('oc-task').addEventListener('input', renderOcSession);
$('oc-refresh').addEventListener('click', () => loadOpenCode(true));
$('oc-refresh-models').addEventListener('click', () => loadOpenCode(true));
$('oc-save').addEventListener('click', saveOpenCode);
$('oc-reset').addEventListener('click', () => {
  if (!oc.baseline) return;
  oc.draft = JSON.parse(oc.baseline);
  renderOcRoles();
  ocUpdateDirty();
  showToast('已还原为 Fusion 保存的 OpenCode 角色');
});
$('oc-plan').addEventListener('click', () =>
  runOcSession('plan', { task: $('oc-task').value.trim() })
);
$('oc-execute').addEventListener('click', () =>
  runOcSession('execute', { sessionId: oc.session?.id || '' })
);
$('oc-review').addEventListener('click', () =>
  runOcSession('review', { sessionId: oc.session?.id || '' })
);
$('oc-reset-session').addEventListener('click', () => runOcSession('reset'));

document.addEventListener('click', () => {
  for (const picker of ocPickers.values()) picker.close();
});

// ── Codex ───────────────────────────────────────────────────────────────────

let cx = { status: null, draft: null, baseline: '', session: null, models: [] };
let cxCwd = localStorage.getItem('fusionCxCwd') || '';
let cxBusy = false;
const cxPickers = new Map();
const cxRoleNodes = new Map();

function cxModelBySelector(selector) {
  if (!selector) return null;
  return (cx.models || []).find((model) => model.selector === selector) || null;
}

function cxRoleRaw(role) {
  const entry = cx.draft?.roles?.[role];
  if (!entry || !entry.model) return '';
  return entry.effort ? `${entry.model}#${entry.effort}` : entry.model;
}

function cxUpdateDirty() {
  if (!cx.draft) return;
  const dirty = JSON.stringify(cx.draft) !== cx.baseline;
  const hint = $('cx-dirty-hint');
  if (dirty) {
    hint.textContent = '有未保存修改';
    hint.classList.add('dirty');
    hint.classList.remove('saved');
  } else {
    hint.textContent = '已同步';
    hint.classList.remove('dirty', 'saved');
  }
  $('cx-save').disabled = !dirty || cxBusy;
  $('cx-save').textContent = dirty ? '保存到 Fusion' : '已同步';
}

function renderCxEnv() {
  const status = cx.status;
  if (!status) return;
  const connector = status.connector || {};
  $('cx-version').textContent = `Codex · ${status.version || '未检测到'}`;
  $('cx-version').className = `pill ${status.version ? 'ok' : 'err'}`;
  $('cx-env').innerHTML = [
    kvRow('可执行文件', status.executable || '未检测到', status.executable ? 'ok' : 'err'),
    kvRow('版本', status.version || '未检测到', status.version ? 'ok' : 'err'),
    kvRow('登录', status.login || '未知'),
    kvRow('配置文件', status.configPath || ''),
    kvRow('验收隔离', status.isolation || ''),
    kvRow('模型目录', `${(cx.models || []).length} 个`),
  ].join('');
  $('cx-models-count').textContent = `模型目录 · ${(cx.models || []).length}`;
  const errorCard = $('cx-error');
  const message = status.modelError || connector.error || '';
  if (message) {
    errorCard.textContent = message;
    errorCard.classList.remove('hidden');
  } else {
    errorCard.classList.add('hidden');
  }
}

function renderCxRaw(role) {
  const node = cxRoleNodes.get(role);
  if (!node) return;
  const raw = cxRoleRaw(role);
  node.raw.textContent = raw || '未设置';
  node.raw.className = `role-raw${raw ? '' : ' unset'}`;
}

function renderCxEfforts(role) {
  const node = cxRoleNodes.get(role);
  if (!node) return;
  const entry = cx.draft?.roles?.[role] || { model: '', effort: '' };
  const model = cxModelBySelector(entry.model);
  if (!entry.model) {
    node.thinkRow.innerHTML = '<span class="think-note">未选择模型时使用 Codex 默认档位。</span>';
    return;
  }
  if (!model) {
    node.thinkRow.innerHTML = '<span class="think-note">模型不在当前目录中，保存前请重新选择。</span>';
    return;
  }
  if (!model.efforts?.length) {
    node.thinkRow.innerHTML = '<span class="think-note">该模型未声明思考档，使用模型默认档。</span>';
    return;
  }
  const current = entry.effort || '';
  const pill = (value, label) =>
    `<button class="pill-btn${current === value ? ' active' : ''}" data-effort="${esc(value)}">${esc(label)}</button>`;
  node.thinkRow.innerHTML =
    '<span class="think-label">思考档</span>' +
    pill('', '默认') +
    model.efforts.map((effort) => pill(effort, effort)).join('');
  node.thinkRow.querySelectorAll('.pill-btn').forEach((button) => {
    button.addEventListener('click', () => {
      entry.effort = button.dataset.effort || '';
      renderCxEfforts(role);
      renderCxRaw(role);
      cxUpdateDirty();
    });
  });
}

function setCxRoleModel(role, selector) {
  const entry = cx.draft.roles[role] || (cx.draft.roles[role] = { model: '', effort: '' });
  entry.model = selector;
  if (!selector) {
    entry.effort = '';
  } else {
    const model = cxModelBySelector(selector);
    entry.effort = model?.defaultEffort || '';
  }
  const picker = cxPickers.get(role);
  if (picker) picker.renderValue();
  renderCxRaw(role);
  renderCxEfforts(role);
  cxUpdateDirty();
}

function mountCxPicker(host, role) {
  host.innerHTML = `
    <button type="button" class="mp-trigger">
      <span class="mp-val placeholder"></span>
      <span class="mp-caret" aria-hidden="true"></span>
    </button>
    <div class="mp-pop">
      <div class="mp-search-row">
        <input class="mp-search" type="search" placeholder="搜索模型 / 名称（空格分词）" />
        <span class="mp-count"></span>
      </div>
      <div class="mp-list"></div>
    </div>`;

  const trigger = host.querySelector('.mp-trigger');
  const valueEl = host.querySelector('.mp-val');
  const searchEl = host.querySelector('.mp-search');
  const countEl = host.querySelector('.mp-count');
  const listEl = host.querySelector('.mp-list');

  const picker = {
    role,
    host,
    renderValue() {
      const selector = cx.draft.roles[role]?.model || '';
      if (!selector) {
        valueEl.className = 'mp-val placeholder';
        valueEl.textContent = '（未设置 / 使用 Codex 默认）';
        return;
      }
      const model = cxModelBySelector(selector);
      valueEl.className = 'mp-val';
      valueEl.innerHTML = model
        ? `<span class="mp-name">${esc(model.name)}</span><span class="mp-sel">${esc(model.selector)}</span>`
        : `<span class="mp-name">${esc(selector)}</span>`;
    },
    renderList(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const models = cx.models || [];
      const filtered = terms.length
        ? models.filter((model) => {
            const haystack = `${model.selector} ${model.name} ${model.description || ''}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
          })
        : models;
      countEl.textContent = `${filtered.length} / ${models.length}`;
      if (!filtered.length) {
        listEl.innerHTML = '<div class="mp-empty">没有匹配的模型</div>';
        return;
      }
      const shown = filtered.slice(0, 300);
      listEl.innerHTML =
        '<button class="mp-item clear" data-sel=""><span class="mi-name">（未设置 / 使用 Codex 默认）</span></button>' +
        shown
          .map(
            (model) => `
          <button class="mp-item" data-sel="${esc(model.selector)}">
            <span class="mi-left">
              <span class="mi-name">${esc(model.name)}</span>
              <span class="mi-sel">${esc(model.selector)}</span>
            </span>
            <span class="mi-tag">${model.efforts?.length ? `${model.efforts.length} 档` : '默认'}</span>
          </button>`
          )
          .join('');
      listEl.querySelectorAll('.mp-item').forEach((item) => {
        item.addEventListener('click', () => {
          setCxRoleModel(role, item.dataset.sel || '');
          picker.close();
        });
      });
    },
    open() {
      for (const other of cxPickers.values()) {
        if (other !== picker) other.close();
      }
      host.classList.add('open');
      searchEl.value = '';
      picker.renderList('');
      setTimeout(() => searchEl.focus(), 0);
    },
    close() {
      host.classList.remove('open');
    },
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (host.classList.contains('open')) picker.close();
    else picker.open();
  });
  searchEl.addEventListener('input', () => picker.renderList(searchEl.value));
  host.addEventListener('click', (event) => event.stopPropagation());
  cxPickers.set(role, picker);
  picker.renderValue();
}

function renderCxRoles() {
  const host = $('cx-roles');
  if (!host) return;
  host.innerHTML = '';
  cxPickers.clear();
  cxRoleNodes.clear();
  if (!cx.draft) return;
  for (const role of cx.status?.roles || []) {
    const card = document.createElement('div');
    card.className = 'role-card';
    card.dataset.role = role.role;
    card.innerHTML = `
      <div class="role-head">
        <div>
          <div class="role-name">${esc(role.label)}<span class="role-key">${esc(role.role)}</span></div>
          <div class="role-desc">${esc(role.description)}</div>
        </div>
        <div class="role-raw unset" title="Codex ${esc(role.role)}">未设置</div>
      </div>
      <div class="mp"></div>
      <div class="think-row"></div>
      <div class="cost-line"></div>`;
    cxRoleNodes.set(role.role, {
      card,
      raw: card.querySelector('.role-raw'),
      thinkRow: card.querySelector('.think-row'),
      costLine: card.querySelector('.cost-line'),
    });
    mountCxPicker(card.querySelector('.mp'), role.role);
    renderCxRaw(role.role);
    renderCxEfforts(role.role);
    const model = cxModelBySelector(cx.draft.roles[role.role]?.model);
    card.querySelector('.cost-line').textContent = model
      ? model.description || 'Codex 模型'
      : '未选择模型';
    host.appendChild(card);
  }
}

function renderCxReview() {
  const host = $('cx-review-result');
  if (!host) return;
  const result = cx.status?.review;
  if (!result || !result.verdict) {
    host.innerHTML = '<span class="muted">尚未运行</span>';
    return;
  }
  const verdict = String(result.verdict).toLowerCase();
  const label =
    verdict === 'pass'
      ? 'PASS'
      : verdict === 'rework'
        ? 'REWORK'
        : verdict === 'skip'
          ? 'SKIP'
          : 'FAILED';
  const meta = [];
  if (result.host) meta.push(result.host);
  if (result.model) meta.push(result.model);
  if (result.effort) meta.push(`effort ${result.effort}`);
  if (result.actualModel && result.actualModel !== result.model) meta.push(`实际 ${result.actualModel}`);
  if (result.actualEffort && result.actualEffort !== result.effort) meta.push(`实际档 ${result.actualEffort}`);
  if (result.rerouted) meta.push(`重路由 ${result.rerouted}`);
  if (result.files) meta.push(`${result.files} 个文件`);
  if (result.diffChars) meta.push(`${result.diffChars} 字符`);
  if (result.durationMs) meta.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.at) meta.push(new Date(result.at).toLocaleString('zh-CN', { hour12: false }));
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const summary = result.summary || '';
  host.innerHTML = `
    <div><span class="verdict ${verdict}">${label}</span> <span class="review-meta">${esc(meta.join(' · '))}</span></div>
    ${summary ? `<div class="review-summary">${esc(summary)}</div>` : ''}
    ${findings.length ? `<ul class="review-findings">${findings.slice(0, 20).map((finding) => `<li><b>${esc(finding.severity || 'info')}</b> ${esc(finding.file || '')}${finding.line ? `:${finding.line}` : ''} — ${esc(finding.message || '')}</li>`).join('')}</ul>` : ''}`;
}

function renderCxSession() {
  const session = cx.session;
  const phase = session?.phase || '';
  const pill = $('cx-session-pill');
  if (pill) {
    pill.textContent = phase === 'planned' ? '待确认' : phase === 'executed' ? '已执行' : '未开始';
    pill.className = `pill ${phase === 'planned' ? 'warn' : phase === 'executed' ? 'ok' : ''}`;
  }
  $('cx-plan-output').textContent = session?.plan || '尚未开始';
  $('cx-exec-output').textContent = session?.execution || '尚未执行';
  if (session?.task && !$('cx-task').value) $('cx-task').value = session.task;
  const cwd = ($('cx-cwd').value || cxCwd).trim();
  const task = $('cx-task').value.trim();
  $('cx-plan').disabled = cxBusy || !cwd || !task;
  $('cx-execute').disabled = cxBusy || !session || session.phase !== 'planned';
  $('cx-review').disabled = cxBusy || !session || session.phase !== 'executed';
  $('cx-reset-session').disabled = cxBusy || !session;
  const planMeta = session
    ? `规划 ${session.planModel || '—'}${session.planEffort ? `#${session.planEffort}` : ''}${session.planActualModel && session.planActualModel !== session.planModel ? `（实际 ${session.planActualModel}）` : ''}`
    : '';
  const execMeta = session?.executionModel
    ? `执行 ${session.executionModel}${session.executionEffort ? `#${session.executionEffort}` : ''}${session.executionActualModel && session.executionActualModel !== session.executionModel ? `（实际 ${session.executionActualModel}）` : ''}`
    : '';
  const rerouteMeta = [
    session?.planRerouted ? `规划重路由 ${session.planRerouted}` : '',
    session?.executionRerouted ? `执行重路由 ${session.executionRerouted}` : '',
  ].filter(Boolean).join(' · ');
  $('cx-session-status').textContent = session
    ? `会话 ${session.id} · ${planMeta}${execMeta ? ` · ${execMeta}` : ''}${rerouteMeta ? ` · ${rerouteMeta}` : ''}`
    : '填写工作区与任务后开始规划；规划确认前不会进入执行。';
  renderCxReview();
}

function applyCxStatus(status) {
  cx.status = status;
  cx.models = status.models || [];
  cx.session = status.session || null;
  if (status.cwd) {
    cxCwd = status.cwd;
    localStorage.setItem('fusionCxCwd', cxCwd);
  }
  const cwdInput = $('cx-cwd');
  if (cwdInput && !cwdInput.value) cwdInput.value = cxCwd;
  cx.draft = { roles: {} };
  for (const role of status.roles || []) {
    cx.draft.roles[role.role] = { model: role.model || '', effort: role.effort || '' };
  }
  cx.baseline = JSON.stringify(cx.draft);
  renderCxEnv();
  renderCxRoles();
  renderCxSession();
  cxUpdateDirty();
}

async function loadCodex(force = false) {
  const cwd = ($('cx-cwd')?.value || cxCwd).trim();
  try {
    const status = await api('/api/codex', { cwd, force });
    applyCxStatus(status);
  } catch (error) {
    showToast(`Codex 读取失败：${error.message}`, true);
    const card = $('cx-error');
    if (card) {
      card.textContent = error.message;
      card.classList.remove('hidden');
    }
  }
}

async function saveCodex() {
  if (!cx.draft) return;
  $('cx-save').disabled = true;
  try {
    const status = await api('/api/codex/save', {
      cwd: ($('cx-cwd').value || cxCwd).trim(),
      roles: cx.draft.roles,
    });
    applyCxStatus(status);
    showToast('Codex 角色模型已保存');
  } catch (error) {
    showToast(error.message, true);
    cxUpdateDirty();
  }
}

async function runCxSession(action, extra = {}) {
  if (cxBusy) return;
  const cwd = ($('cx-cwd').value || cxCwd).trim();
  if (!cwd) {
    showToast('请填写工作区路径', true);
    return;
  }
  cxBusy = true;
  renderCxSession();
  $('cx-session-status').textContent =
    action === 'plan'
      ? '规划中…'
      : action === 'execute'
        ? '执行中…'
        : action === 'review'
          ? '验收中…'
          : '正在清除会话…';
  try {
    const status = await api('/api/codex/session', { action, cwd, ...extra });
    cxBusy = false;
    applyCxStatus(status);
    showToast(
      action === 'plan'
        ? '规划完成；确认后再执行'
        : action === 'execute'
          ? '执行完成；可运行验收'
          : action === 'review'
            ? '验收完成'
            : '会话已清除'
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    cxBusy = false;
    renderCxSession();
    setTimeout(renderCxSession, 0);
  }
}

$('cx-cwd').value = cxCwd;
$('cx-cwd').addEventListener('input', () => {
  cxCwd = $('cx-cwd').value;
  localStorage.setItem('fusionCxCwd', cxCwd);
  renderCxSession();
});
$('cx-cwd').addEventListener('change', () => {
  if ($('tab-codex').classList.contains('active')) loadCodex(false);
});
$('cx-task').addEventListener('input', renderCxSession);
$('cx-refresh').addEventListener('click', () => loadCodex(true));
$('cx-refresh-models').addEventListener('click', () => loadCodex(true));
$('cx-save').addEventListener('click', saveCodex);
$('cx-reset').addEventListener('click', () => {
  if (!cx.baseline) return;
  cx.draft = JSON.parse(cx.baseline);
  renderCxRoles();
  cxUpdateDirty();
  showToast('已还原为 Fusion 保存的 Codex 角色');
});
$('cx-plan').addEventListener('click', () =>
  runCxSession('plan', { task: $('cx-task').value.trim() })
);
$('cx-execute').addEventListener('click', () =>
  runCxSession('execute', { sessionId: cx.session?.id || '' })
);
$('cx-review').addEventListener('click', () =>
  runCxSession('review', { sessionId: cx.session?.id || '' })
);
$('cx-reset-session').addEventListener('click', () => runCxSession('reset'));

document.addEventListener('click', () => {
  for (const picker of cxPickers.values()) picker.close();
});

// ── Overview ────────────────────────────────────────────────────────────────

function kvRow(key, value, cls = '') {
  return `<div class="kv-row"><span class="kv-key">${esc(key)}</span><span class="kv-val ${cls}">${esc(value)}</span></div>`;
}

function renderOverview() {
  const fusion = catalog.fusion || {};
  const connectors = catalog.connectors || {};
  const targets = connectors.targets || [];
  const registered = targets.filter((target) => target.connected);

  $('overview-fusion').innerHTML = [
    kvRow('Fusion 版本', fusion.version || '未检测到', fusion.version ? 'ok' : 'err'),
    kvRow('本程序', fusion.executable || ''),
    kvRow('MCP 服务名', connectors.serverName || 'fusion'),
    kvRow('Agent 目标', `${targets.length} 个`),
    kvRow('已注册', `${registered.length} 个`),
  ].join('');

  $('overview-agents').innerHTML = targets
    .map((target) =>
      kvRow(
        target.label,
        `${capabilityLabel(target)}${target.connected ? ' · 已注册' : ''}`,
        target.connected ? 'ok' : ''
      )
    )
    .join('');

  const snippet = connectors.snippets?.mcpServers || '';
  $('overview-usage').textContent = [
    '1) 直接启动控制台：',
    '   orzic-fusion.exe',
    '',
    '2) 以 MCP stdio 方式供 Agent 调用：',
    '   orzic-fusion.exe mcp',
    '',
    '3) 在目标 Agent 的 mcpServers 中加入：',
    snippet,
    '',
    '4) MCP 工具：fusion_status / fusion_models / fusion_roles_set /',
    '   fusion_save / fusion_resolve / fusion_connect / fusion_open_console',
  ].join('\n');
}

// ── State application ───────────────────────────────────────────────────────

function buildDraft(omp) {
  return {
    roles: Object.fromEntries(
      (omp.roles || []).map((role) => [
        role.role,
        { model: role.model || '', thinking: role.thinking || '' },
      ])
    ),
    flags: { ...(omp.flags || {}) },
    defaultThinkingLevel: omp.defaultThinkingLevel || 'high',
  };
}

function renderOmpEnv(omp) {
  const pendingVersion = !!omp.versionPending && !omp.version;
  const versionPill = $('omp-version');
  versionPill.textContent = `OMP · ${omp.version || (pendingVersion ? '读取中…' : '未检测到')}`;
  versionPill.className = `pill ${omp.version ? 'ok' : 'err'}`;
  $('omp-env').innerHTML = [
    kvRow('可执行文件', omp.executable || '未检测到', omp.executable ? 'ok' : 'err'),
    kvRow('版本', omp.version || (pendingVersion ? '读取中…' : '未检测到'), omp.version ? 'ok' : pendingVersion ? '' : 'err'),
    kvRow('Agent 目录', omp.agentDir || ''),
    kvRow('配置文件', omp.configPath || ''),
  ].join('');
  updateModelsCount();

  const errorCard = $('omp-error');
  if (omp.error) {
    errorCard.textContent = `OMP 读取失败：${omp.error}`;
    errorCard.classList.remove('hidden');
  } else {
    errorCard.classList.add('hidden');
  }
}

function applyExtras(state) {
  if (state.acceptance) {
    app.acceptance = { ...(app.acceptance || {}), ...state.acceptance };
    if (!reviewCwd && state.acceptance.cwd) reviewCwd = state.acceptance.cwd;
    syncReviewAuto();
    renderReviewResult();
  }
  if (state.connectors) {
    catalog.connectors = state.connectors;
    renderAgents();
    renderActiveMcp();
    renderSnippet();
    renderOverview();
  }
}

function applyState(state, { merge = false } = {}) {
  if (!state || !state.omp) return;
  if (!merge) {
    app.omp = state.omp;
    if (Array.isArray(state.models)) app.models = state.models;
    renderOmpEnv(state.omp);
    draft = buildDraft(state.omp);
    baseline = JSON.stringify(draft);
    draftTouched = false;
    renderFlags();
    renderRoles();
    updateDirty();
  } else {
    app.omp = { ...(app.omp || {}), ...state.omp };
    if (Array.isArray(state.models)) app.models = state.models;
    renderOmpEnv(app.omp);
    const dirty = draft && JSON.stringify(draft) !== baseline;
    if (!dirty) {
      draft = buildDraft(app.omp);
      baseline = JSON.stringify(draft);
      draftTouched = false;
      renderFlags();
      renderRoles();
    }
    updateDirty();
  }
  applyExtras(state);
}

// Fast paint from cached config, then the full status (model directory and
// version) in the background. Both share one in-flight fast request.
function fetchOmpFast(force = false) {
  if (!force && ompPrefetch) return ompPrefetch;
  const request = api(`/api/omp/status?fast=1${force ? '&force=1' : ''}`).finally(() => {
    if (ompPrefetch === request) ompPrefetch = null;
  });
  if (!force) ompPrefetch = request;
  return request;
}

async function loadState(force = false) {
  lastSavedAt = '';
  try {
    applyState(await fetchOmpFast(force));
  } catch (error) {
    ompPrefetch = null;
    showToast(`加载失败：${error.message}`, true);
  }
  try {
    applyState(await api(`/api/omp/status${force ? '?force=1' : ''}`), { merge: true });
  } catch (error) {
    showToast(`完整状态读取失败：${error.message}`, true);
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

$('btn-refresh').addEventListener('click', async () => {
  await loadCatalog();
  if (currentAgent === 'omp') await loadState(true);
  if (currentAgent === 'opencode') await loadOpenCode(true);
  if (currentAgent === 'codex') await loadCodex(true);
  showToast('状态已刷新');
});

$('btn-refresh-models').addEventListener('click', async () => {
  const button = $('btn-refresh-models');
  button.disabled = true;
  try {
    const data = await api('/api/models?force=1');
    app.models = data.models || [];
    updateModelsCount();
    renderRoles();
    renderOverview();
    showToast(`模型目录已刷新 · ${app.models.length} 个`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('btn-reset').addEventListener('click', () => {
  if (!baseline) return;
  lastSavedAt = '';
  draft = JSON.parse(baseline);
  draftTouched = false;
  renderFlags();
  renderRoles();
  updateDirty();
  showToast('已还原为磁盘配置');
});

$('btn-save').addEventListener('click', async () => {
  $('btn-save').disabled = true;
  try {
    const state = await api('/api/save', {
      roles: draft.roles,
      flags: draft.flags,
      defaultThinkingLevel: draft.defaultThinkingLevel,
    });
    lastSavedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    applyState(state);
    showToast(`已保存到 OMP · ${lastSavedAt}`);
  } catch (error) {
    showToast(error.message, true);
    updateDirty();
  }
});

$('btn-shutdown').addEventListener('click', async () => {
  try {
    await api('/api/shutdown', {});
  } catch {
    /* server may close the socket first */
  }
  window.close();
  setTimeout(() => showToast('服务已停止，可关闭此页面'), 400);
});

window.addEventListener('beforeunload', () => {
  if (TOKEN) {
    navigator.sendBeacon(`/api/closing?token=${encodeURIComponent(TOKEN)}`);
  }
});

setInterval(() => {
  api('/api/heartbeat', {}).catch(() => {});
}, 5000);

setInterval(() => {
  if (currentAgent) loadMemory();
}, 5000);

loadCatalog();

// Warm the cached config while the directory is on screen so the first OMP
// open does not wait for `omp config list`.
setTimeout(() => {
  if (!app.omp) fetchOmpFast().catch(() => {});
}, 250);
