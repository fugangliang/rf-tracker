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
const cols = ['date', 'sleep', 'hrv', 'rhr', 'bb', 'stress', 'stressHighMin', 'steps', 'kcalOut', 'kcalIn', 'protein', 'weight', 'fat', 'muscle', 'mood', 'confounds'];
const head = ['日付', '睡眠', 'HRV', '安静HR', 'BB回復', 'ストレス', '高スト分', '歩数', '消費', '摂取', 'タンパク', '体重', '体脂肪', '骨格筋', '気分', '交絡/フラグ'];
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
process.stdout.write(lines.join('\n') + '\n');
