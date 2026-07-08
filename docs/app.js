/* RF基準線トラッカー UI＋永続化（IndexedDB）。ロジックは logic.js(RFLogic) に集約。 */
'use strict';
const L = RFLogic;

/* ================= IndexedDB ================= */
const DB_NAME = 'rf-tracker', DB_VER = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'date' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
async function getAllEntries() {
  const rows = await new Promise((resolve, reject) => {
    const t = db.transaction('entries', 'readonly');
    const req = t.objectStore('entries').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  return rows;
}
function putEntries(entries) {
  return tx('entries', 'readwrite', s => { for (const e of entries) s.put(e); });
}
function getMeta(key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}
function setMeta(key, value) {
  return tx('meta', 'readwrite', s => s.put({ key, value }));
}

/* ================= 共通ヘルパー ================= */
const $ = sel => document.querySelector(sel);
const view = () => $('#view');
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtNum(v, digits = 1) { return typeof v === 'number' ? v.toFixed(digits).replace(/\.0+$/, m => digits === 0 ? '' : m) : '—'; }
function fmtDev(d) { return d === null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`; }
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent; btn.textContent = 'コピーしました';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    // Safariのフォールバック
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    btn.textContent = 'コピーしました';
    setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
  }
}

/* ================= タブ制御 ================= */
const TABS = { dashboard: renderDashboard, import: renderImport, record: renderRecord, trend: renderTrend, monthly: renderMonthly, backup: renderBackup };
let currentTab = 'dashboard';
async function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  await TABS[tab]();
}

/* ================= F3 ダッシュボード ================= */
const METRIC_DEFS = [
  { key: 'hrv', name: 'HRV', unit: 'ms', digits: 0 },
  { key: 'rhr', name: '安静時心拍', unit: 'bpm', digits: 0, reversed: true },
  { key: 'sleep', name: '睡眠スコア', unit: '', digits: 0 },
  { key: 'bb', name: 'Body Battery', unit: '', digits: 0 },
  { key: 'weight', name: '体重', unit: 'kg', digits: 1, showChange: true, sparse: true },
  { key: 'fat', name: '体脂肪率', unit: '%', digits: 1, showChange: true, sparse: true },
];

async function renderDashboard() {
  const entries = await getAllEntries();
  if (!entries.length) {
    view().innerHTML = `<div class="card"><h2>状態</h2><p class="muted">データがありません。「取込」タブからインポートしてください。</p></div>`;
    return;
  }
  const latest = entries[entries.length - 1];
  const r = L.recovery(entries, latest);
  const fm = L.FAILURE_MODES[r.level];
  const mood = L.moodTrack(entries, latest, r.level);
  const headerText = L.statusHeaderText(entries, latest);

  let levelHtml;
  if (r.level === 'building') {
    levelHtml = `<div class="status-level level-building">基準構築中</div>
      <div class="status-sub">n&lt;7: ${r.building.join(', ')}</div>`;
  } else {
    levelHtml = `<div class="status-level level-${r.level}">回復度 ${fm.label}</div>`;
    if (r.relaxed) levelHtml += `<div class="notice">golf交絡により1段階緩和（${L.FAILURE_MODES[r.preRelaxLevel].label}→${fm.label}）</div>`;
  }
  const devLine = ['hrv', 'sleep', 'bb'].map(m =>
    `${m.toUpperCase()} ${fmtDev(r.deviations[m])}`).join(' / ');

  let moodHtml;
  if (mood.building) {
    moodHtml = `<span class="label">気分:</span> ${typeof latest.mood === 'number' ? latest.mood : '—'} <span class="muted">基準構築中(n=${mood.baseline.n})</span>`;
  } else if (typeof latest.mood === 'number' && mood.baseline.mean !== null) {
    moodHtml = `<span class="label">気分:</span> ${latest.mood}（基準${mood.baseline.mean.toFixed(1)}比 ${mood.deviationPt >= 0 ? '+' : ''}${mood.deviationPt.toFixed(1)}pt）`;
  } else {
    moodHtml = `<span class="label">気分:</span> —`;
  }

  let html = `<div class="card">
    <h2>状態ヘッダー（${latest.date}）</h2>
    ${levelHtml}
    <div class="status-line"><span class="label">基準線比:</span> ${devLine}</div>
    <div class="status-line"><span class="label">予測故障モード:</span> ${esc(fm.mode)}</div>
    <div class="status-line"><span class="label">プロトコル:</span> ${esc(fm.protocol)}</div>
    <div class="status-line"><span class="label">警告灯感度:</span> ${fm.sensitivity === '高' ? '<b class="level-low">高</b>' : '標準'}</div>
    <div class="status-line">${moodHtml}</div>
    ${mood.flag ? `<div class="flag">主観-客観乖離: ${esc(mood.flag)}</div>` : ''}
    ${latest.edema ? `<div class="notice">浮腫フラグ: 体組成値は割り引いて解釈</div>` : ''}
    ${latest.confounds.length ? `<div class="status-line"><span class="label">交絡:</span> ${latest.confounds.join(', ')}</div>` : ''}
    <button class="btn secondary" id="copy-status">状態ヘッダーを全文コピー</button>
  </div>`;

  html += `<div class="metric-grid">`;
  for (const md of METRIC_DEFS) {
    const b = L.baseline(entries, latest.date, md.key);
    let valueHtml, refHtml, staleNote = '';
    let val = latest[md.key], valDate = latest.date;
    if (typeof val !== 'number' && md.sparse) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (typeof entries[i][md.key] === 'number') { val = entries[i][md.key]; valDate = entries[i].date; break; }
      }
      if (valDate !== latest.date && typeof val === 'number') staleNote = `<span class="stale">（${valDate} 実測）</span>`;
    }
    if (typeof val === 'number') {
      valueHtml = `${fmtNum(val, md.digits)}<small> ${md.unit}</small>`;
      const dev = L.deviationPct(val, b.mean);
      let devCls = '';
      if (dev !== null) {
        if (md.reversed) devCls = dev >= 10 ? 'dev-concern' : (dev <= 0 ? 'dev-pos' : '');
        else devCls = dev >= 0 ? 'dev-pos' : 'dev-neg';
      }
      refHtml = `基準線 ${b.mean !== null ? fmtNum(b.mean, md.digits) : '—'}${md.unit}（n=${b.n}）`;
      if (md.showChange || !md.sparse) refHtml += dev !== null ? ` <span class="${devCls}">${fmtDev(dev)}</span>` : '';
      refHtml += staleNote;
    } else {
      valueHtml = `—`;
      refHtml = `基準線 ${b.mean !== null ? fmtNum(b.mean, md.digits) : '—'}${md.unit}（n=${b.n}）`;
    }
    html += `<div class="metric-card">
      <div class="name">${md.name}</div>
      <div class="value">${valueHtml}</div>
      <div class="ref">${refHtml}</div>
    </div>`;
  }
  html += `</div>`;

  view().innerHTML = html;
  $('#copy-status').addEventListener('click', e => copyText(headerText, e.target));
  updateBackupBadge();
}

/* ================= F2 インポート ================= */
async function renderImport() {
  view().innerHTML = `<div class="card">
    <h2>JSONインポート（日次運用の主入口）</h2>
    <textarea id="import-text" placeholder='[{"date":"2026-07-08","hrv":34,...}] をペースト'></textarea>
    <button class="btn" id="import-btn">取込</button>
    <div class="result" id="import-result"></div>
  </div>`;
  $('#import-btn').addEventListener('click', doImport);
}

async function doImport() {
  const text = $('#import-text').value.trim();
  const out = $('#import-result');
  out.textContent = ''; // 前回結果を消してから処理（取り違え防止）
  if (!text) { out.textContent = 'JSONをペーストしてください'; out.className = 'result err'; return; }
  const existing = await getAllEntries();
  const res = L.parseImport(text, existing);
  if (res.entries.length) await putEntries(res.entries);
  const lines = [];
  lines.push(`取込 ${res.entries.length}件${res.errors.length ? ` / エラー ${res.errors.length}件` : ''}`);
  if (res.edemaDetected.length) lines.push(`浮腫シグネチャ自動検出: ${res.edemaDetected.join(', ')}（体重↑・体脂肪率↓・骨格筋率↑）`);
  for (const err of res.errors) lines.push(`✗ ${err.date ?? `行${err.index !== null ? err.index + 1 : '?'}`}: ${err.reason}`);
  out.textContent = lines.join('\n');
  out.className = 'result ' + (res.errors.length ? 'err' : 'ok');
  if (res.entries.length) {
    const total = (await getAllEntries()).length;
    out.textContent += `\n総エントリ数: ${total}`;
  }
}

/* ================= F1 記録（手入力） ================= */
async function renderRecord() {
  const entries = await getAllEntries();
  const today = todayStr();
  const ex = entries.find(e => e.date === today) || null;
  const v = (f) => ex && ex[f] !== null && ex[f] !== undefined ? ex[f] : '';
  view().innerHTML = `<div class="card">
    <h2>手入力（同一日付は上書き）</h2>
    <label class="field">日付<input type="date" id="f-date" value="${today}"></label>
    <div class="field-row">
      <label class="field">HRV (ms)<input type="number" step="any" id="f-hrv" value="${v('hrv')}"></label>
      <label class="field">安静時心拍 (bpm)<input type="number" step="any" id="f-rhr" value="${v('rhr')}"></label>
      <label class="field">睡眠スコア<input type="number" step="any" id="f-sleep" value="${v('sleep')}"></label>
      <label class="field">Body Battery<input type="number" step="any" id="f-bb" value="${v('bb')}"></label>
      <label class="field">体重 (kg)<input type="number" step="any" id="f-weight" value="${v('weight')}"></label>
      <label class="field">体脂肪率 (%)<input type="number" step="any" id="f-fat" value="${v('fat')}"></label>
      <label class="field">骨格筋率 (%)<input type="number" step="any" id="f-muscle" value="${v('muscle')}"></label>
      <label class="field">内臓脂肪レベル<input type="number" step="any" id="f-visceral" value="${v('visceral')}"></label>
    </div>
    <label class="field">寝起きの気分（1〜5）</label>
    <div class="mood-btns" id="f-mood">
      ${[1, 2, 3, 4, 5].map(n => `<button type="button" data-v="${n}" class="${ex && ex.mood === n ? 'sel' : ''}">${n}</button>`).join('')}
    </div>
    <label class="field" style="margin-top:10px">交絡</label>
    <div class="check-row">
      ${L.CONFOUNDS.map(c => `<label><input type="checkbox" data-c="${c}" ${ex && ex.confounds.includes(c) ? 'checked' : ''}>${c}</label>`).join('')}
    </div>
    <div class="check-row" style="margin-top:10px">
      <label><input type="checkbox" id="f-exclude" ${ex && ex.excludeBaseline ? 'checked' : ''}>基準線から除外</label>
      <label><input type="checkbox" id="f-edema" ${ex && ex.edema ? 'checked' : ''}>浮腫フラグ</label>
    </div>
    <label class="field" style="margin-top:10px">メモ<input type="text" id="f-note" value="${ex ? esc(ex.note) : ''}"></label>
    <button class="btn" id="save-btn">保存</button>
    <div class="result" id="save-result"></div>
  </div>`;

  let moodSel = ex && typeof ex.mood === 'number' ? ex.mood : null;
  $('#f-mood').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const val = +b.dataset.v;
    moodSel = moodSel === val ? null : val; // 再タップで解除
    document.querySelectorAll('#f-mood button').forEach(x => x.classList.toggle('sel', +x.dataset.v === moodSel));
  });

  $('#f-date').addEventListener('change', async () => {
    // 日付を変えたら既存値を読み直す
    const d = $('#f-date').value;
    const all = await getAllEntries();
    if (all.find(e => e.date === d)) { await renderRecordFor(d); }
  });

  $('#save-btn').addEventListener('click', async () => {
    $('#save-result').textContent = '';
    const num = id => { const s = $(id).value.trim(); return s === '' ? null : +s; };
    const entry = {
      date: $('#f-date').value,
      hrv: num('#f-hrv'), rhr: num('#f-rhr'), sleep: num('#f-sleep'), bb: num('#f-bb'),
      weight: num('#f-weight'), mood: moodSel, fat: num('#f-fat'), muscle: num('#f-muscle'),
      visceral: num('#f-visceral'),
      confounds: [...document.querySelectorAll('.check-row input[data-c]')].filter(c => c.checked).map(c => c.dataset.c),
      excludeBaseline: $('#f-exclude').checked,
      edema: $('#f-edema').checked,
      note: $('#f-note').value
    };
    // parseImport経由でバリデーション＋浮腫自動検出を一本化
    const existing = await getAllEntries();
    const res = L.parseImport(JSON.stringify([entry]), existing);
    const out = $('#save-result');
    if (res.errors.length) {
      out.textContent = res.errors.map(e => e.reason).join('\n');
      out.className = 'result err';
      return;
    }
    await putEntries(res.entries);
    out.textContent = `保存しました（${entry.date}）` +
      (res.edemaDetected.length ? `\n浮腫シグネチャ自動検出: 体組成値は割り引いて解釈` : '');
    out.className = 'result ok';
  });
}
async function renderRecordFor(_d) { await renderRecord(); const d = _d; $('#f-date').value = d; }

/* ================= F4 トレンド ================= */
const TREND_METRICS = [
  { key: 'hrv', name: 'HRV' }, { key: 'rhr', name: '安静時心拍' },
  { key: 'sleep', name: '睡眠' }, { key: 'bb', name: 'BB' },
  { key: 'weight', name: '体重' }, { key: 'mood', name: '気分' },
  { key: 'fat', name: '体脂肪率' }, { key: 'muscle', name: '骨格筋率' },
];
let trendState = { metric: 'hrv', weeks: 4 };

async function renderTrend() {
  view().innerHTML = `<div class="card">
    <h2>トレンド</h2>
    <div class="seg" id="trend-weeks">
      <button data-w="4" class="${trendState.weeks === 4 ? 'sel' : ''}">直近4週</button>
      <button data-w="12" class="${trendState.weeks === 12 ? 'sel' : ''}">直近12週</button>
    </div>
    <select id="trend-metric">
      ${TREND_METRICS.map(m => `<option value="${m.key}" ${trendState.metric === m.key ? 'selected' : ''}>${m.name}</option>`).join('')}
    </select>
    <div id="chart-wrap" style="margin-top:10px"></div>
    <p class="muted" style="margin-top:6px">点線＝現在の28日基準線</p>
  </div>`;
  $('#trend-weeks').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    trendState.weeks = +b.dataset.w; renderTrend();
  });
  $('#trend-metric').addEventListener('change', e => { trendState.metric = e.target.value; renderTrend(); });
  await drawChart();
}

async function drawChart() {
  const entries = await getAllEntries();
  const wrap = $('#chart-wrap');
  if (!entries.length) { wrap.innerHTML = '<p class="muted">データなし</p>'; return; }
  const latest = entries[entries.length - 1].date;
  const endNum = L.dateToNum(latest);
  const startNum = endNum - trendState.weeks * 7 + 1;
  const m = trendState.metric;
  const pts = entries
    .filter(e => L.dateToNum(e.date) >= startNum && typeof e[m] === 'number')
    .map(e => ({ x: L.dateToNum(e.date) - startNum, y: e[m], date: e.date, excluded: L.isExcludedFromBaseline(e) }));
  if (!pts.length) { wrap.innerHTML = '<p class="muted">この期間の記録なし</p>'; return; }

  const b = L.baseline(entries, latest, m);
  const W = 680, H = 300, PL = 46, PR = 12, PT = 12, PB = 30;
  const xMax = trendState.weeks * 7 - 1;
  let yMin = Math.min(...pts.map(p => p.y)), yMax = Math.max(...pts.map(p => p.y));
  if (b.mean !== null) { yMin = Math.min(yMin, b.mean); yMax = Math.max(yMax, b.mean); }
  const pad = (yMax - yMin) * 0.1 || 1; yMin -= pad; yMax += pad;
  const X = x => PL + x / xMax * (W - PL - PR);
  const Y = y => PT + (1 - (y - yMin) / (yMax - yMin)) * (H - PT - PB);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  // Y軸目盛
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yMax - yMin) * i / 4;
    svg += `<line x1="${PL}" y1="${Y(yv)}" x2="${W - PR}" y2="${Y(yv)}" stroke="#334155" stroke-width="1"/>`;
    svg += `<text x="${PL - 6}" y="${Y(yv) + 4}" fill="#94a3b8" font-size="11" text-anchor="end">${yv.toFixed(yMax - yMin < 10 ? 1 : 0)}</text>`;
  }
  // X軸ラベル（週区切り）
  for (let wk = 0; wk <= trendState.weeks; wk += (trendState.weeks > 4 ? 2 : 1)) {
    const x = Math.min(wk * 7, xMax);
    const dnum = startNum + x;
    const d = new Date(dnum * 86400000);
    const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    svg += `<text x="${X(x)}" y="${H - 8}" fill="#94a3b8" font-size="11" text-anchor="middle">${label}</text>`;
  }
  // 基準線（ReferenceLine相当）
  if (b.mean !== null) {
    svg += `<line x1="${PL}" y1="${Y(b.mean)}" x2="${W - PR}" y2="${Y(b.mean)}" stroke="#5eead4" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    svg += `<text x="${W - PR}" y="${Y(b.mean) - 5}" fill="#5eead4" font-size="11" text-anchor="end">基準線 ${b.mean.toFixed(1)}</text>`;
  }
  // 折れ線＋点
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  svg += `<path d="${path}" fill="none" stroke="#e2e8f0" stroke-width="2"/>`;
  for (const p of pts) {
    svg += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="${p.excluded ? '#64748b' : '#e2e8f0'}"><title>${p.date}: ${p.y}</title></circle>`;
  }
  svg += `</svg>`;
  wrap.innerHTML = svg;
}

/* ================= F5 月次サマリー ================= */
async function renderMonthly() {
  const entries = await getAllEntries();
  const months = [...new Set(entries.map(e => e.date.slice(0, 7)))].sort().reverse();
  if (!months.length) {
    view().innerHTML = `<div class="card"><h2>月次サマリー</h2><p class="muted">データなし</p></div>`;
    return;
  }
  view().innerHTML = `<div class="card">
    <h2>月次サマリー（基準線ドキュメント更新用）</h2>
    <select id="month-sel">${months.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
    <button class="btn secondary" id="copy-monthly" style="margin-top:10px">全文コピー</button>
    <pre class="mono" id="monthly-out" style="margin-top:10px"></pre>
  </div>`;
  const update = () => { $('#monthly-out').textContent = L.monthlySummary(entries, $('#month-sel').value); };
  $('#month-sel').addEventListener('change', update);
  $('#copy-monthly').addEventListener('click', e => copyText($('#monthly-out').textContent, e.target));
  update();
}

/* ================= F6 バックアップ ================= */
async function renderBackup() {
  const entries = await getAllEntries();
  const last = await getMeta('lastExport');
  const overdue = isBackupOverdue(last);
  view().innerHTML = `<div class="card">
    <h2>バックアップ</h2>
    <p class="muted">総エントリ数: ${entries.length}</p>
    <p class="muted">最終エクスポート: ${last ? new Date(last).toLocaleString('ja-JP') : 'なし'}
      ${overdue ? '<span class="badge">7日超過</span>' : ''}</p>
    <button class="btn" id="export-btn">全データをJSONでエクスポート</button>
    <p class="muted" style="margin-top:8px">エクスポート形式はインポートと同一スキーマ。再取込で完全復元できる。週1回のエクスポートを推奨。</p>
    <div class="result" id="export-result"></div>
  </div>
  <div class="card">
    <h2>全データ再取込</h2>
    <p class="muted">エクスポートしたJSONは「取込」タブにペーストすれば復元される（同一経路）。</p>
  </div>`;
  $('#export-btn').addEventListener('click', async () => {
    const json = L.exportJSON(await getAllEntries());
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rf-tracker-export_${todayStr().replace(/-/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    await setMeta('lastExport', Date.now());
    $('#export-result').textContent = 'エクスポートしました';
    $('#export-result').className = 'result ok';
    updateBackupBadge();
    renderBackup();
  });
}
function isBackupOverdue(last) {
  return !last || (Date.now() - last) > 7 * 86400000;
}
async function updateBackupBadge() {
  const last = await getMeta('lastExport');
  const entries = await getAllEntries();
  $('#backup-badge').classList.toggle('hidden', !(entries.length && isBackupOverdue(last)));
}

/* ================= 起動 ================= */
(async function main() {
  db = await openDB();
  document.querySelectorAll('#tabbar button').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
  await switchTab('dashboard');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ローカルfile://等では無視 */ });
  }
})();
