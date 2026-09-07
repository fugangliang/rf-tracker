/* RF基準線トラッカー UI＋永続化（IndexedDB）。ロジックは logic.js(RFLogic) に集約。v1.4.0: 減量タブ追加、v1.5.0: 自動同期(sync.js) */
'use strict';
const L = RFLogic;
const APP_VERSION = '1.5.1'; // sw.js の VERSION と揃える（保全タブに表示・更新確認用）

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
const TABS = { dashboard: renderDashboard, import: renderImport, record: renderRecord, trend: renderTrend, loss: renderLoss, monthly: renderMonthly, backup: renderBackup };
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
  const goalWeight = await getMeta('goalWeight');
  const opts = { goalWeight: typeof goalWeight === 'number' ? goalWeight : null };
  const cond = L.condition(entries, latest);
  const cmt = L.comments(entries, latest, opts);
  const headerText = L.statusHeaderText(entries, latest, opts);

  // 総合状態（v1.1）: 不調/平常/好調
  let condHtml = `<div class="cond-state cond-${cond.state}">${L.CONDITION_LABELS[cond.state]}</div>`;
  if (cond.avgDev !== null) condHtml += `<div class="status-sub">3指標平均乖離 ${cond.avgDev >= 0 ? '+' : ''}${cond.avgDev.toFixed(1)}%</div>`;

  let levelHtml;
  if (r.level === 'building') {
    levelHtml = `<div class="status-line"><span class="label">回復度:</span> 基準構築中（n&lt;7: ${r.building.join(', ')}）</div>`;
  } else {
    levelHtml = `<div class="status-line"><span class="label">回復度:</span> <b class="level-${r.level}">${fm.label}</b></div>`;
    if (r.relaxed) levelHtml += `<div class="notice">golf交絡により1段階緩和（${L.FAILURE_MODES[r.preRelaxLevel].label}→${fm.label}）</div>`;
  }

  // 信号チップ（HRV/睡眠/BB/安静時心拍）
  const sigNames = { hrv: 'HRV', sleep: '睡眠', bb: 'BB', rhr: '心拍' };
  const sigDevs = { hrv: r.deviations.hrv, sleep: r.deviations.sleep, bb: r.deviations.bb, rhr: cond.rhrDev };
  const sigLine = ['hrv', 'sleep', 'bb', 'rhr'].map(m => {
    const s = cond.signals[m];
    if (!s) return `<span class="chip chip-none">${sigNames[m]} —</span>`;
    return `<span class="chip chip-${s}">${sigNames[m]} ${L.SIGNAL_LABELS[s]}<small> ${fmtDev(sigDevs[m])}</small></span>`;
  }).join('');

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
    ${condHtml}
    <div class="chip-row">${sigLine}</div>
    ${levelHtml}
    <div class="status-line"><span class="label">予測故障モード:</span> ${esc(fm.mode)}</div>
    <div class="status-line"><span class="label">プロトコル:</span> ${esc(fm.protocol)}</div>
    <div class="status-line"><span class="label">警告灯感度:</span> ${fm.sensitivity === '高' ? '<b class="level-low">高</b>' : '標準'}</div>
    <div class="status-line">${moodHtml}</div>
    ${mood.flag ? `<div class="flag">主観-客観乖離: ${esc(mood.flag)}</div>` : ''}
    ${latest.edema ? `<div class="notice">浮腫フラグ: 体組成値は割り引いて解釈</div>` : ''}
    ${latest.confounds.length ? `<div class="status-line"><span class="label">交絡:</span> ${latest.confounds.join(', ')}</div>` : ''}
    <button class="btn secondary" id="copy-status">状態ヘッダーを全文コピー</button>
  </div>
  <div class="card">
    <h2>状態評価コメント</h2>
    <div class="comment-line"><span class="label">体調:</span> ${esc(cmt.condition)}</div>
    <div class="comment-line"><span class="label">体重:</span> ${esc(cmt.weight)}</div>
    <div class="comment-line"><span class="label">体脂肪率:</span> ${esc(cmt.fat)}</div>
    ${opts.goalWeight === null ? '<p class="muted" style="margin-top:6px">目標体重は「保全」タブで設定すると体重コメントに反映される</p>' : ''}
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
      refHtml = `基準線 ${b.mean !== null ? fmtNum(b.mean, md.digits) : '—'}${md.unit}（n=${b.n}/${L.BASELINE_DAYS}）`;
      if (md.showChange || !md.sparse) refHtml += dev !== null ? ` <span class="${devCls}">${fmtDev(dev)}</span>` : '';
      refHtml += staleNote;
    } else {
      valueHtml = `—`;
      refHtml = `基準線 ${b.mean !== null ? fmtNum(b.mean, md.digits) : '—'}${md.unit}（n=${b.n}/${L.BASELINE_DAYS}）`;
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
    <button class="btn" id="import-file-btn">ファイルから取込</button>
    <p class="muted">毎朝の自動生成分: iCloud Drive → rf-tracker → garmin_日付.json を選択（直近7日分入り。取込済みの日は空欄以外だけ更新されるため、毎日取り込まなくても次の1回で追いつく）</p>
    <textarea id="import-text" placeholder='[{"date":"2026-07-08","hrv":34,...}] をペースト'></textarea>
    <button class="btn" id="import-btn">取込</button>
    <label style="display:block;margin-top:8px"><input type="checkbox" id="import-replace">完全置換で取込（機種変更・復元用。既存の同一日付を丸ごと差し替える）</label>
    <div class="result" id="import-result"></div>
  </div>`;
  $('#import-btn').addEventListener('click', doImport);
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json,text/plain';
  $('#import-file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    $('#import-text').value = (await f.text()).trim(); // 内容を可視化してから通常経路で取込
    fileInput.value = '';
    await doImport();
  });
}

async function doImport() {
  const text = $('#import-text').value.trim();
  const out = $('#import-result');
  out.textContent = ''; // 前回結果を消してから処理（取り違え防止）
  if (!text) { out.textContent = 'JSONをペーストしてください'; out.className = 'result err'; return; }
  const existing = await getAllEntries();
  const replace = $('#import-replace') && $('#import-replace').checked;
  const res = L.parseImport(text, existing, { merge: !replace });
  if (res.entries.length) await putEntries(res.entries);
  const existingDates = new Set(existing.map(e => e.date));
  const added = res.entries.filter(e => !existingDates.has(e.date)).length;
  const lines = [];
  lines.push(`取込 ${res.entries.length}件（新規${added}・${replace ? '置換' : '更新'}${res.entries.length - added}）${res.errors.length ? ` / エラー ${res.errors.length}件` : ''}`);
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
async function renderRecord(dateArg) {
  const entries = await getAllEntries();
  // v1.4.0修正: 日付変更時は選択日の既存値を読み込む（従来は当日の値のまま日付だけ変わり、保存で別日を上書きしていた）
  const today = typeof dateArg === 'string' && L.isValidDateStr(dateArg) ? dateArg : todayStr();
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
    <label class="field" style="margin-top:10px">活動・食事（v1.4）</label>
    <div class="field-row">
      <label class="field">歩数<input type="number" step="any" id="f-steps" value="${v('steps')}"></label>
      <label class="field">消費kcal (Garmin)<input type="number" step="any" id="f-kcalout" value="${v('kcalOut')}"></label>
      <label class="field">活動kcal<input type="number" step="any" id="f-kcalactive" value="${v('kcalActive')}"></label>
      <label class="field">摂取kcal<input type="number" step="any" id="f-kcalin" value="${v('kcalIn')}"></label>
      <label class="field">タンパク質 (g)<input type="number" step="any" id="f-protein" value="${v('protein')}"></label>
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
    await renderRecord($('#f-date').value);
  });

  $('#save-btn').addEventListener('click', async () => {
    $('#save-result').textContent = '';
    const num = id => { const s = $(id).value.trim(); return s === '' ? null : +s; };
    const entry = {
      date: $('#f-date').value,
      hrv: num('#f-hrv'), rhr: num('#f-rhr'), sleep: num('#f-sleep'), bb: num('#f-bb'),
      weight: num('#f-weight'), mood: moodSel, fat: num('#f-fat'), muscle: num('#f-muscle'),
      visceral: num('#f-visceral'),
      steps: num('#f-steps'), kcalOut: num('#f-kcalout'), kcalActive: num('#f-kcalactive'),
      kcalIn: num('#f-kcalin'), protein: num('#f-protein'),
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

/* ================= F4 トレンド ================= */
const TREND_METRICS = [
  { key: 'hrv', name: 'HRV' }, { key: 'rhr', name: '安静時心拍' },
  { key: 'sleep', name: '睡眠' }, { key: 'bb', name: 'BB' },
  { key: 'weight', name: '体重' }, { key: 'mood', name: '気分' },
  { key: 'fat', name: '体脂肪率' }, { key: 'muscle', name: '骨格筋率' },
  { key: 'steps', name: '歩数' }, { key: 'kcalIn', name: '摂取kcal' }, { key: 'kcalOut', name: '消費kcal' },
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
  const syncCfg = await getSyncConfig();
  const syncLast = await getMeta('syncLast');
  view().innerHTML = `<div class="card">
    <h2>バックアップ</h2>
    <p class="muted">アプリ版: v${APP_VERSION} / 総エントリ数: ${entries.length}</p>
    <p class="muted">最終エクスポート: ${last ? new Date(last).toLocaleString('ja-JP') : 'なし'}
      ${overdue ? '<span class="badge">7日超過</span>' : ''}</p>
    <button class="btn" id="export-btn">全データをJSONでエクスポート</button>
    <p class="muted" style="margin-top:8px">エクスポート形式はインポートと同一スキーマ。再取込で完全復元できる。週1回のエクスポートを推奨。</p>
    <div class="result" id="export-result"></div>
  </div>
  <div class="card">
    <h2>全データ再取込</h2>
    <p class="muted">エクスポートしたJSONは「取込」タブにペーストすれば復元される（同一経路）。</p>
  </div>
  <div class="card">
    <h2>自動同期（v1.5.0・非公開リポジトリ経由）</h2>
    <p class="muted">Macの自動取得が暗号化した写しを非公開リポジトリに置き、アプリが起動時・復帰時に取得して自動マージする。手入力（気分等）は上書きされない。</p>
    <label class="field">設定文字列（rfsync1:…・MacのQRから貼付）<input type="text" id="sync-setup" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${syncCfg.repo ? '設定済み: ' + syncCfg.repo : 'rfsync1:owner/repo:鍵'}"></label>
    <label class="field">読み取り専用トークン（GitHub fine-grained PAT）<input type="password" id="sync-token" autocomplete="off" placeholder="${syncCfg.token ? '設定済み（変更時のみ入力）' : 'github_pat_…'}"></label>
    <div class="field-row">
      <button class="btn secondary" id="sync-save">同期設定を保存</button>
      <button class="btn secondary" id="sync-now">今すぐ同期</button>
      <button class="btn secondary" id="sync-clear">同期を解除</button>
    </div>
    <p class="muted" style="margin-top:6px">最終同期: ${syncLast ? `${new Date(syncLast.at).toLocaleString('ja-JP')} — ${esc(syncLast.message)}` : 'なし'}</p>
    <div class="result" id="sync-result"></div>
  </div>
  <div class="card">
    <h2>設定</h2>
    <label class="field">目標体重 (kg)<input type="number" step="0.1" id="goal-weight" value="${typeof (await getMeta('goalWeight')) === 'number' ? await getMeta('goalWeight') : ''}"></label>
    <div class="field-row">
      <label class="field">赤字目標 (kcal/日・既定${L.WL_DEFAULTS.deficitTarget})<input type="number" step="10" id="goal-deficit" value="${typeof (await getMeta('deficitTarget')) === 'number' ? await getMeta('deficitTarget') : ''}"></label>
      <label class="field">タンパク質目標 (g/日・既定${L.WL_DEFAULTS.proteinTarget})<input type="number" step="5" id="goal-protein" value="${typeof (await getMeta('proteinTarget')) === 'number' ? await getMeta('proteinTarget') : ''}"></label>
    </div>
    <button class="btn secondary" id="goal-save">設定を保存</button>
    <p class="muted" style="margin-top:6px">この端末のみに保存され、状態評価コメントの体重評価と減量タブの判定に使われる。空欄は既定値。</p>
    <div class="result" id="goal-result"></div>
  </div>`;
  $('#sync-save').addEventListener('click', async () => {
    const out = $('#sync-result');
    const setupStr = $('#sync-setup').value.trim();
    const tokenStr = $('#sync-token').value.trim();
    let cfg = { ...syncCfg };
    if (setupStr) {
      const parsed = RFSync.parseSetup(setupStr);
      if (!parsed) { out.textContent = '設定文字列の形式が不正（rfsync1:owner/repo:鍵）'; out.className = 'result err'; return; }
      cfg.repo = parsed.repo; cfg.key = parsed.key;
    }
    if (tokenStr) cfg.token = tokenStr;
    if (!cfg.repo || !cfg.key || !cfg.token) { out.textContent = '設定文字列とトークンの両方が必要'; out.className = 'result err'; return; }
    await setMeta('syncRepo', cfg.repo); await setMeta('syncKey', cfg.key); await setMeta('syncToken', cfg.token);
    $('#sync-setup').value = ''; $('#sync-token').value = '';
    out.textContent = '同期設定を保存。今すぐ同期を実行…'; out.className = 'result ok';
    const r = await runSync({ manual: true });
    out.textContent = r.message; out.className = 'result ' + (r.ok ? 'ok' : 'err');
    if (r.ok) renderBackup();
  });
  $('#sync-now').addEventListener('click', async () => {
    const out = $('#sync-result');
    out.textContent = '同期中…'; out.className = 'result';
    const r = await runSync({ manual: true });
    out.textContent = r.message; out.className = 'result ' + (r.ok ? 'ok' : 'err');
  });
  $('#sync-clear').addEventListener('click', async () => {
    for (const k of ['syncRepo', 'syncKey', 'syncToken', 'syncLast', 'syncLastUpdated']) await setMeta(k, null);
    updateSyncBadge(null);
    await renderBackup();
    $('#sync-result').textContent = '同期設定を解除しました'; $('#sync-result').className = 'result ok';
  });
  $('#goal-save').addEventListener('click', async () => {
    const s = $('#goal-weight').value.trim();
    const v = s === '' ? null : +s;
    if (v !== null && (!isFinite(v) || v <= 0)) {
      $('#goal-result').textContent = '正の数値を入力（空欄で解除）';
      $('#goal-result').className = 'result err';
      return;
    }
    const parseOpt = id => { const t = $(id).value.trim(); return t === '' ? null : +t; };
    const dv = parseOpt('#goal-deficit'), pv = parseOpt('#goal-protein');
    for (const x of [dv, pv]) {
      if (x !== null && (!isFinite(x) || x <= 0)) {
        $('#goal-result').textContent = '赤字目標・タンパク質目標は正の数値（空欄で既定値）';
        $('#goal-result').className = 'result err';
        return;
      }
    }
    await setMeta('goalWeight', v);
    await setMeta('deficitTarget', dv);
    await setMeta('proteinTarget', pv);
    $('#goal-result').textContent = (v === null ? '目標体重を解除' : `目標体重 ${v}kg`) +
      ` / 赤字目標 ${dv === null ? `既定${L.WL_DEFAULTS.deficitTarget}` : dv}kcal / タンパク質 ${pv === null ? `既定${L.WL_DEFAULTS.proteinTarget}` : pv}g を保存しました`;
    $('#goal-result').className = 'result ok';
  });
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


/* ================= F7 減量モニタリング（v1.4.0） ================= */
const WL_CHIP = {
  good: 'blue', on: 'blue', ok: 'blue', up: 'blue',
  stall: 'yellow', flat: 'yellow', below: 'yellow', low: 'yellow', down: 'yellow',
  fast: 'red', gain: 'red', lean_loss: 'red', fat_gain: 'red', above: 'red',
  insufficient: 'none'
};
async function wlOpts() {
  const g = await getMeta('goalWeight'), d = await getMeta('deficitTarget'), p = await getMeta('proteinTarget');
  return {
    goalWeight: typeof g === 'number' ? g : null,
    deficitTarget: typeof d === 'number' ? d : L.WL_DEFAULTS.deficitTarget,
    proteinTarget: typeof p === 'number' ? p : L.WL_DEFAULTS.proteinTarget
  };
}
async function renderLoss() {
  const entries = await getAllEntries();
  const opts = await wlOpts();
  const today = todayStr();
  if (!entries.length) {
    view().innerHTML = `<div class="card"><h2>減量モニター</h2><p class="muted">データがありません。「取込」タブからインポートしてください。</p></div>`;
    return;
  }
  const latest = entries[entries.length - 1];
  const asOf = latest.date > today ? latest.date : today;
  const w = L.weightLossStatus(entries, asOf, opts);
  const text = L.weightLossText(entries, asOf, opts);
  const chip = (axis, state) => `<span class="chip chip-${WL_CHIP[state]}">${axis} ${L.WL_LABELS[axis === 'ペース' ? 'pace' : axis === '体組成' ? 'composition' : axis === '収支' ? 'energy' : axis === 'タンパク質' ? 'protein' : 'activity'][state]}</span>`;

  // 体重測定が途絶えている場合の注意（最新実測から7日超）
  let staleHtml = '';
  if (!w.latest) staleHtml = `<div class="notice">体重の記録がない。OMRONで測定し、9:30の自動取得前にオムロンコネクトへ転送する。</div>`;
  else if (L.dateToNum(asOf) - L.dateToNum(w.latest.date) > 7) staleHtml = `<div class="notice">最新の体重実測が ${w.latest.date}（${L.dateToNum(asOf) - L.dateToNum(w.latest.date)}日前）。判定には週2回以上の測定が要る。OMRON転送は9:30前に。</div>`;

  let weightLine;
  if (w.latest) {
    weightLine = `<span class="label">体重:</span> <b>${w.latest.weight.toFixed(1)}kg</b> <span class="muted">（${w.latest.date}実測${w.latest.edema ? '・浮腫' : ''}）</span>`;
    if (w.goalWeight !== null) weightLine += w.remaining > 0 ? ` 目標${w.goalWeight.toFixed(1)}kgまで残り<b>${w.remaining.toFixed(1)}kg</b>` : ` 目標${w.goalWeight.toFixed(1)}kg達成`;
  } else {
    weightLine = `<span class="label">体重:</span> —`;
  }

  const fm = w.composition.fatMass, lm = w.composition.leanMass;
  const fmtKg = v => typeof v === 'number' ? v.toFixed(1) : '—';
  const fmtDiff = v => typeof v === 'number' ? `<span class="${v <= -0.3 ? 'dev-pos' : v >= 0.3 ? 'dev-neg' : ''}">${v >= 0 ? '+' : ''}${v.toFixed(2)}kg</span>` : '';
  const cards = [
    { name: '減量ペース（28日窓）', value: w.pace.slopeKgWeek !== null ? `${w.pace.slopeKgWeek >= 0 ? '+' : ''}${w.pace.slopeKgWeek.toFixed(2)}<small> kg/週</small>` : '—', ref: `有効体重 n=${w.pace.n}・期間${w.pace.spanDays}日${w.pace.monthly ? `<br>28日平均 前28日比 ${w.pace.monthly.diff >= 0 ? '+' : ''}${w.pace.monthly.diff.toFixed(1)}kg` : ''}` },
    { name: '脂肪量（28日平均）', value: `${fmtKg(fm.recent)}<small> kg</small>`, ref: `前28日 ${fmtKg(fm.prior)}kg ${fmtDiff(fm.diff)}（n=${fm.nRecent}/${fm.nPrior}）` },
    { name: '除脂肪量（28日平均）', value: `${fmtKg(lm.recent)}<small> kg</small>`, ref: `前28日 ${fmtKg(lm.prior)}kg ${lm.diff !== null ? `<span class="${lm.diff < -0.3 ? 'dev-neg' : ''}">${lm.diff >= 0 ? '+' : ''}${lm.diff.toFixed(2)}kg</span>` : ''}（n=${lm.nRecent}/${lm.nPrior}）` },
    { name: '収支（7日平均・Garmin推定）', value: w.energy.deficit !== null ? `${Math.round(w.energy.deficit)}<small> kcal赤字/日</small>` : '—', ref: `摂取 ${w.energy.kcalIn !== null ? Math.round(w.energy.kcalIn) : '—'} / 消費 ${w.energy.kcalOut !== null ? Math.round(w.energy.kcalOut) : '—'}（目標赤字${w.energy.target}・n=${w.energy.n}）${w.energy.expectedKgWeek !== null ? `<br>理論ペース ${w.energy.expectedKgWeek >= 0 ? '+' : ''}${w.energy.expectedKgWeek.toFixed(2)}kg/週` : ''}` },
    { name: 'タンパク質（7日平均）', value: w.energy.protein.mean !== null ? `${Math.round(w.energy.protein.mean)}<small> g</small>` : '—', ref: `目標${w.energy.protein.target}g（n=${w.energy.protein.n}）` },
    { name: '歩数（7日平均）', value: w.activity.steps7 !== null ? `${Math.round(w.activity.steps7).toLocaleString()}<small> 歩</small>` : '—', ref: `基準線 ${w.activity.stepsBase.mean !== null ? Math.round(w.activity.stepsBase.mean).toLocaleString() : '—'}歩（n=${w.activity.stepsBase.n}/${L.BASELINE_DAYS}）${w.activity.stepsDev !== null ? ` <span class="${w.activity.stepsDev >= 0 ? 'dev-pos' : 'dev-neg'}">${fmtDev(w.activity.stepsDev)}</span>` : ''}${w.activity.kcalActive7 !== null ? `<br>活動kcal ${Math.round(w.activity.kcalActive7)}/日` : ''}` },
  ];

  const ex = entries.find(e => e.date === today);
  view().innerHTML = `<div class="card">
    <h2>減量モニター（${asOf}）</h2>
    <div class="chip-row">${chip('ペース', w.pace.state)}${chip('体組成', w.composition.state)}${chip('収支', w.energy.state)}${chip('タンパク質', w.energy.protein.state)}${chip('活動量', w.activity.state)}</div>
    <div class="status-line">${weightLine}</div>
    ${staleHtml}
    <div class="comment-line"><span class="label">減量ペース:</span> ${esc(w.pace.reason)}</div>
    <div class="comment-line"><span class="label">体組成の質:</span> ${esc(w.composition.reason)}</div>
    <div class="comment-line"><span class="label">収支:</span> ${esc(w.energy.reason)}</div>
    <div class="comment-line"><span class="label">活動量:</span> ${esc(w.activity.reason)}</div>
    <p class="muted" style="margin-top:6px">判定軸は「減量ペース」（月2kg超の急減禁止）と「体組成の質」（脂肪↓・除脂肪維持）。収支・タンパク質・活動量は補助。浮腫日・基準線除外日は算入しない。</p>
    <button class="btn secondary" id="copy-loss">全文コピー</button>
  </div>
  <div class="card">
    <h2>食事クイック入力（既存の値は消えない）</h2>
    <div class="field-row">
      <label class="field">日付<input type="date" id="q-date" value="${today}"></label>
      <label class="field">摂取kcal<input type="number" step="any" id="q-kcalin" value="${ex && typeof ex.kcalIn === 'number' ? ex.kcalIn : ''}"></label>
      <label class="field">タンパク質 (g)<input type="number" step="any" id="q-protein" value="${ex && typeof ex.protein === 'number' ? ex.protein : ''}"></label>
    </div>
    <button class="btn" id="q-save">保存</button>
    <p class="muted" style="margin-top:6px">空欄の項目は変更しない。値の消去は「記録」タブで行う。</p>
    <div class="result" id="q-result"></div>
  </div>
  <div class="metric-grid">${cards.map(c => `<div class="metric-card"><div class="name">${c.name}</div><div class="value">${c.value}</div><div class="ref">${c.ref}</div></div>`).join('')}</div>
  <div class="card" style="margin-top:12px">
    <h2>体重 直近12週</h2>
    <div id="loss-chart"></div>
    <p class="muted" style="margin-top:6px">点＝実測（黄＝浮腫日・灰＝基準線除外日）、実線＝7日移動平均（浮腫・除外日を除く）、点線＝目標体重</p>
  </div>`;
  $('#copy-loss').addEventListener('click', e => copyText(text, e.target));
  $('#q-date').addEventListener('change', async () => {
    const d = $('#q-date').value;
    const e = (await getAllEntries()).find(x => x.date === d);
    $('#q-kcalin').value = e && typeof e.kcalIn === 'number' ? e.kcalIn : '';
    $('#q-protein').value = e && typeof e.protein === 'number' ? e.protein : '';
  });
  $('#q-save').addEventListener('click', async () => {
    const out = $('#q-result');
    const num = id => { const t = $(id).value.trim(); return t === '' ? null : +t; };
    const rec = { date: $('#q-date').value, kcalIn: num('#q-kcalin'), protein: num('#q-protein') };
    if (rec.kcalIn === null && rec.protein === null) { out.textContent = '摂取kcalかタンパク質を入力'; out.className = 'result err'; return; }
    const existing = await getAllEntries();
    const res = L.parseImport(JSON.stringify([rec]), existing, { merge: true }); // マージ＝自動取得値・手入力を保全
    if (res.errors.length) { out.textContent = res.errors.map(e => e.reason).join('\n'); out.className = 'result err'; return; }
    await putEntries(res.entries);
    out.textContent = `保存しました（${rec.date}）`; out.className = 'result ok';
    await renderLoss();
    $('#q-result').textContent = `保存しました（${rec.date}）`; $('#q-result').className = 'result ok';
  });
  drawWeightChart(entries, asOf, opts.goalWeight);
}

/* 体重チャート（12週固定）: 実測点＋7日移動平均＋目標体重点線。drawChart（推移タブ）とは独立 */
function drawWeightChart(entries, asOf, goalWeight) {
  const wrap = $('#loss-chart');
  const weeks = 12;
  const endNum = L.dateToNum(asOf);
  const startNum = endNum - weeks * 7 + 1;
  const pts = entries
    .filter(e => L.dateToNum(e.date) >= startNum && L.dateToNum(e.date) <= endNum && typeof e.weight === 'number')
    .map(e => ({ x: L.dateToNum(e.date) - startNum, y: e.weight, date: e.date, edema: e.edema === true, excluded: L.isExcludedFromBaseline(e) }));
  if (!pts.length) { wrap.innerHTML = '<p class="muted">この期間の体重記録なし</p>'; return; }
  const ma = L.movingAverageSeries(entries, asOf, 'weight', weeks, 7);
  const W = 680, H = 300, PL = 46, PR = 12, PT = 12, PB = 30;
  const xMax = weeks * 7 - 1;
  const ys = pts.map(p => p.y).concat(ma.map(p => p.y));
  if (typeof goalWeight === 'number') ys.push(goalWeight);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  const pad = (yMax - yMin) * 0.1 || 1; yMin -= pad; yMax += pad;
  const X = x => PL + x / xMax * (W - PL - PR);
  const Y = y => PT + (1 - (y - yMin) / (yMax - yMin)) * (H - PT - PB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yMax - yMin) * i / 4;
    svg += `<line x1="${PL}" y1="${Y(yv)}" x2="${W - PR}" y2="${Y(yv)}" stroke="#334155" stroke-width="1"/>`;
    svg += `<text x="${PL - 6}" y="${Y(yv) + 4}" fill="#94a3b8" font-size="11" text-anchor="end">${yv.toFixed(1)}</text>`;
  }
  for (let wk = 0; wk <= weeks; wk += 2) {
    const x = Math.min(wk * 7, xMax);
    const d = new Date((startNum + x) * 86400000);
    svg += `<text x="${X(x)}" y="${H - 8}" fill="#94a3b8" font-size="11" text-anchor="middle">${d.getUTCMonth() + 1}/${d.getUTCDate()}</text>`;
  }
  if (typeof goalWeight === 'number') {
    svg += `<line x1="${PL}" y1="${Y(goalWeight)}" x2="${W - PR}" y2="${Y(goalWeight)}" stroke="#5eead4" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    svg += `<text x="${W - PR}" y="${Y(goalWeight) - 5}" fill="#5eead4" font-size="11" text-anchor="end">目標 ${goalWeight.toFixed(1)}</text>`;
  }
  if (ma.length > 1) {
    // 記録が7日以上途切れた区間（移動平均が存在しない日をまたぐ）は線をつながない
    const path = ma.map((p, i) => `${i === 0 || p.x - ma[i - 1].x > 1 ? 'M' : 'L'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    svg += `<path d="${path}" fill="none" stroke="#e2e8f0" stroke-width="2"/>`;
  }
  for (const p of pts) {
    const fill = p.edema ? '#fbbf24' : p.excluded ? '#64748b' : '#94a3b8';
    svg += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="${fill}"><title>${p.date}: ${p.y}kg${p.edema ? '（浮腫）' : ''}${p.excluded ? '（除外）' : ''}</title></circle>`;
  }
  svg += `</svg>`;
  wrap.innerHTML = svg;
}


/* ================= 自動同期（v1.5.0） =================
 * 非公開リポジトリの data.enc（AES-256-GCM）を取得→復号→マージ取込。鍵・トークンはIndexedDB metaのみ。
 * 失敗しても従来の「ファイルから取込」で運用継続できる（同期は付加経路）。 */
async function getSyncConfig() {
  const repo = await getMeta('syncRepo'), key = await getMeta('syncKey'), token = await getMeta('syncToken');
  return { repo: typeof repo === 'string' ? repo : null, key: typeof key === 'string' ? key : null, token: typeof token === 'string' ? token : null };
}
let syncRunning = false, syncLastAttempt = 0;
async function runSync(opts) {
  const manual = !!(opts && opts.manual);
  if (syncRunning) return { ok: false, state: 'busy', message: '同期実行中' };
  const cfg = await getSyncConfig();
  if (!cfg.repo || !cfg.key || !cfg.token) return { ok: false, state: 'unconfigured', message: '同期未設定（保全タブで設定）' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, state: 'offline', message: 'オフラインのため同期スキップ' };
  syncRunning = true; syncLastAttempt = Date.now();
  updateSyncBadge({ pending: true });
  let result;
  try {
    const fr = await RFSync.fetchEnvelope(cfg.repo, cfg.token);
    if (!fr.ok) {
      const msgs = { auth: 'トークンが無効または期限切れ（保全タブで再設定）', notfound: '配信ファイルなし（Mac側の初回pushを確認）', network: 'ネットワーク到達不可', http: `取得失敗 HTTP ${fr.status}` };
      result = { ok: false, state: fr.reason, message: msgs[fr.reason] || '取得失敗' };
    } else {
      const lastUpdated = await getMeta('syncLastUpdated');
      if (!manual && fr.envelope.updated && fr.envelope.updated === lastUpdated) {
        result = { ok: true, state: 'uptodate', message: `最新（${fr.envelope.updated}）` };
      } else {
        let text;
        try { text = await RFSync.decryptEnvelope(fr.envelope, cfg.key); }
        catch (e) { result = { ok: false, state: 'key', message: '復号失敗（設定文字列の鍵が一致しない）' }; }
        if (text !== undefined) {
          const existing = await getAllEntries();
          const res = L.parseImport(text, existing, { merge: true });
          if (res.entries.length) await putEntries(res.entries);
          const existingDates = new Set(existing.map(e => e.date));
          const added = res.entries.filter(e => !existingDates.has(e.date)).length;
          await setMeta('syncLastUpdated', fr.envelope.updated || null);
          result = { ok: true, state: 'updated', added, updated: res.entries.length - added,
            message: `同期取込 ${res.entries.length}件（新規${added}・更新${res.entries.length - added}）${res.errors.length ? ` / エラー${res.errors.length}` : ''}${res.edemaDetected.length ? ` / 浮腫検出 ${res.edemaDetected.join(', ')}` : ''}` };
        }
      }
    }
  } catch (e) {
    result = { ok: false, state: 'error', message: '同期エラー: ' + (e && e.message ? e.message : e) };
  } finally {
    syncRunning = false;
  }
  await setMeta('syncLast', { at: Date.now(), ok: result.ok, state: result.state, message: result.message });
  updateSyncBadge(result);
  if (result.state === 'updated' && TABS[currentTab]) await TABS[currentTab]();
  return result;
}
function updateSyncBadge(r) {
  const b = $('#sync-badge');
  if (!b) return;
  if (r === null) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  if (r.pending) { b.textContent = '同期中'; b.classList.remove('err'); return; }
  if (r.ok) {
    const d = new Date();
    b.textContent = `同期 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    b.classList.remove('err');
  } else if (r.state === 'unconfigured') {
    b.classList.add('hidden');
  } else {
    b.textContent = r.state === 'offline' ? '同期: オフライン' : '同期エラー';
    b.classList.toggle('err', r.state !== 'offline');
  }
  b.title = r.message || '';
}
/* 起動時と、バックグラウンドからの復帰時（10分以上経過）に同期する */
function setupAutoSync() {
  runSync({});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - syncLastAttempt > 10 * 60 * 1000) runSync({});
  });
  window.addEventListener('online', () => { if (Date.now() - syncLastAttempt > 60 * 1000) runSync({}); });
  $('#sync-badge').addEventListener('click', () => runSync({ manual: true }));
}

/* ================= 起動 ================= */
(async function main() {
  db = await openDB();
  document.querySelectorAll('#tabbar button').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
  await switchTab('dashboard');
  setupAutoSync();
  if ('serviceWorker' in navigator) {
    // 新版のSWが制御を取ったら自動で再読み込み（従来は2回開き直す必要があった）
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || !navigator.serviceWorker.controller) return;
      reloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js')
      .then(reg => reg.update().catch(() => {}))
      .catch(() => { /* ローカルfile://等では無視 */ });
  }
})();
