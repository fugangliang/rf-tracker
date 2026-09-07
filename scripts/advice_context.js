#!/usr/bin/env node
/* アドバイス生成用の文脈テキストを写し（data/mirror.json）から組み立てる（v1.6.0）。
 * logic.js の基準線・回復度・減量判定をそのまま使い、直近14日の表を付ける。
 * 使い方: node scripts/advice_context.js [YYYY-MM-DD]（省略時は写しの最終日） */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('../docs/logic.js');

const ROOT = path.join(__dirname, '..');
const entries = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mirror.json'), 'utf8'))
  .sort((a, b) => a.date < b.date ? -1 : 1);
const dateArg = process.argv[2];
const entry = dateArg ? entries.find(e => e.date === dateArg) : entries[entries.length - 1];
if (!entry) { console.error('対象日のエントリなし'); process.exit(1); }

// 端末ローカル設定は写しに無いので既定値（目標体重は基準線ドキュメントの85kg）
const opts = { goalWeight: 85, deficitTarget: L.WL_DEFAULTS.deficitTarget, proteinTarget: L.WL_DEFAULTS.proteinTarget };
const lines = [];
lines.push(L.statusHeaderText(entries, entry, opts));
lines.push('');
lines.push(L.weightLossText(entries, entry.date, opts));
lines.push('');

// 負荷（Garminストレス）の基準線比
const stB = L.baseline(entries, entry.date, 'stress');
const stDev = L.deviationPct(entry.stress, stB.mean);
lines.push(`【負荷（Garmin日中ストレス・低いほど良い）】`);
lines.push(`当日: ${typeof entry.stress === 'number' ? entry.stress : '—'}（基準線 ${stB.mean !== null ? stB.mean.toFixed(0) : '—'}・n=${stB.n}/28${stDev !== null ? `・乖離 ${stDev >= 0 ? '+' : ''}${stDev.toFixed(1)}%` : ''}）` +
  ` / 高ストレス ${typeof entry.stressHighMin === 'number' ? entry.stressHighMin + '分' : '—'}`);
lines.push('');

// 直近14日の表（当日を含む）
const end = L.dateToNum(entry.date);
const cols = ['date', 'wd', 'bedHour', 'sleepHrs', 'sleep', 'hrv', 'rhr', 'bb', 'stress', 'stressHighMin', 'steps', 'kcalOut', 'kcalIn', 'protein', 'weight', 'fat', 'muscle', 'mood', 'confounds'];
const head = ['日付', '曜', '就寝', '睡眠h', '睡眠', 'HRV', '安静HR', 'BB回復', 'ストレス', '高スト分', '歩数', '消費', '摂取', 'タンパク', '体重', '体脂肪', '骨格筋', '気分', '交絡/フラグ'];
lines.push('【直近14日（空欄＝未計測。当日の活動・摂取・ストレスは翌日確定のため空）】');
lines.push(head.join('\t'));
for (const e of entries) {
  const d = L.dateToNum(e.date);
  if (d < end - 13 || d > end) continue;
  lines.push(cols.map(c => {
    if (c === 'confounds') {
      const f = [...(e.confounds || [])];
      if (e.edema) f.push('浮腫');
      if (e.excludeBaseline) f.push('除外');
      return f.join(',');
    }
    if (c === 'wd') return ['日', '月', '火', '水', '木', '金', '土'][new Date(e.date + 'T00:00:00Z').getUTCDay()];
    if (c === 'bedHour') { const v = e.bedHour; return typeof v === 'number' ? `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}` : ''; }
    const v = e[c];
    return v === null || v === undefined ? '' : String(v);
  }).join('\t'));
}
lines.push('');
lines.push('【7日平均 vs 28日基準線（当日を含まない）】');
for (const [k, name] of [['sleep', '睡眠'], ['hrv', 'HRV'], ['rhr', '安静時心拍'], ['bb', 'BB回復'], ['stress', 'ストレス'], ['steps', '歩数'], ['kcalIn', '摂取kcal'], ['protein', 'タンパク質']]) {
  const w = L.windowValues(entries, entry.date, 7, k).map(p => p.v);
  const b = L.baseline(entries, entry.date, k);
  const m7 = w.length ? w.reduce((a, b2) => a + b2, 0) / w.length : null;
  lines.push(`${name}: 7日平均 ${m7 !== null ? m7.toFixed(1) : '—'}（n=${w.length}） / 基準線 ${b.mean !== null ? b.mean.toFixed(1) : '—'}（n=${b.n}）`);
}

// ---- 傾向分析（v1.6.1） ----
const num = v => typeof v === 'number' && isFinite(v);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const f1 = v => v === null ? '—' : v.toFixed(1);
const inWin = (e, days) => { const d = L.dateToNum(e.date); return d > end - days && d <= end; };
const last28 = entries.filter(e => inWin(e, 28));
lines.push('');
lines.push('【14日の傾き（最小二乗・単位/週。負=低下）】');
for (const [k, name] of [['sleep', '睡眠'], ['hrv', 'HRV'], ['rhr', '安静時心拍'], ['bb', 'BB回復'], ['stress', 'ストレス'], ['steps', '歩数'], ['weight', '体重']]) {
  const pts = L.windowValues(entries, entry.date, 14, k, { excludeFlagged: k === 'weight' });
  const s = L.slopePerWeek(pts);
  lines.push(`${name}: ${s === null ? 'データ不足' : (s >= 0 ? '+' : '') + s.toFixed(2) + '/週'}（n=${pts.length}）`);
}
lines.push('');
lines.push('【交絡別の翌日指標（直近28日・その交絡がある日の値の平均 vs ない日）】');
for (const c of ['alcohol', 'golf', 'travel']) {
  const withC = last28.filter(e => (e.confounds || []).includes(c));
  const without = last28.filter(e => !(e.confounds || []).includes(c));
  if (withC.length < 2) { lines.push(`${c}: 該当${withC.length}日（比較不能）`); continue; }
  const row = ['hrv', 'sleep', 'bb', 'rhr'].map(k => {
    const a = mean(withC.map(e => e[k]).filter(num)), b2 = mean(without.map(e => e[k]).filter(num));
    return `${k} ${f1(a)} vs ${f1(b2)}`;
  }).join(' / ');
  lines.push(`${c}: 該当${withC.length}日 → ${row}`);
}
lines.push('');
lines.push('【曜日別（直近28日平均）】');
const wdName = ['日', '月', '火', '水', '木', '金', '土'];
for (let w = 1; w <= 7; w++) {
  const wd = w % 7;
  const es = last28.filter(e => new Date(e.date + 'T00:00:00Z').getUTCDay() === wd);
  if (!es.length) continue;
  lines.push(`${wdName[wd]}: 睡眠 ${f1(mean(es.map(e => e.sleep).filter(num)))} / HRV ${f1(mean(es.map(e => e.hrv).filter(num)))} / BB ${f1(mean(es.map(e => e.bb).filter(num)))} / ストレス ${f1(mean(es.map(e => e.stress).filter(num)))} / 歩数 ${f1(mean(es.map(e => e.steps).filter(num)))}（n=${es.length}）`);
}
const bed = last28.filter(e => num(e.bedHour));
if (bed.length >= 4) {
  lines.push('');
  lines.push('【就寝時刻と翌朝指標（直近28日・就寝24:00まで vs 24:00以降）】');
  const early = bed.filter(e => e.bedHour <= 24), late = bed.filter(e => e.bedHour > 24);
  const fm = es => `HRV ${f1(mean(es.map(e => e.hrv).filter(num)))} / 睡眠 ${f1(mean(es.map(e => e.sleep).filter(num)))} / BB ${f1(mean(es.map(e => e.bb).filter(num)))}`;
  lines.push(`24:00まで（n=${early.length}）: ${fm(early)}`);
  lines.push(`24:00以降（n=${late.length}）: ${fm(late)}`);
  lines.push(`就寝時刻の7日平均: ${f1(mean(L.windowValues(entries, entry.date, 7, 'bedHour').map(p => p.v)))}時 / 睡眠時間7日平均: ${f1(mean(L.windowValues(entries, entry.date, 7, 'sleepHrs').map(p => p.v)))}h`);
}
// 体組成の28日履歴（実測のみ）
const bc = last28.filter(e => num(e.weight));
if (bc.length) {
  lines.push('');
  lines.push('【体組成の実測（直近28日）】');
  for (const e of bc) lines.push(`${e.date}: 体重 ${e.weight} / 体脂肪 ${e.fat ?? '—'} / 骨格筋 ${e.muscle ?? '—'} / 内臓脂肪 ${e.visceral ?? '—'}${e.edema ? '（浮腫）' : ''}${e.excludeBaseline ? '（除外）' : ''}`);
}
// 前日の食事内訳（Mac側に保存した Garmin 栄養ログ）
try {
  const prevDate = new Date((end - 1) * 86400000).toISOString().slice(0, 10);
  const nutPath = path.join(ROOT, 'data', 'nutrition', prevDate + '.json');
  if (fs.existsSync(nutPath)) {
    const n = JSON.parse(fs.readFileSync(nutPath, 'utf8'));
    lines.push('');
    lines.push(`【前日 ${prevDate} の食事内訳（Garmin食事ログ）】`);
    for (const m of n.meals || []) lines.push(`${m.name}: ${m.calories ?? '—'}kcal / P${m.protein ?? '—'} F${m.fat ?? '—'} C${m.carbs ?? '—'}${m.foods && m.foods.length ? ' — ' + m.foods.join('、') : ''}`);
    if (n.total) lines.push(`合計: ${n.total.calories ?? '—'}kcal / P${n.total.protein ?? '—'} F${n.total.fat ?? '—'} C${n.total.carbs ?? '—'}（目標 ${n.goals ? `${n.goals.calories}kcal / P${n.goals.protein}` : '—'}）`);
  }
} catch (e) { /* 内訳なしは省略 */ }
process.stdout.write(lines.join('\n') + '\n');
