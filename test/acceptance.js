/* 受け入れ手順（要件§7）＋コアロジックの単体検証。node test/acceptance.js で実行 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('../docs/logic.js');
// 実測データ（data/ は個人健康データのためgitignore。手元にない場合は受け入れ手順部分をスキップ）
const HAS_DATA = fs.existsSync(path.join(__dirname, '../data/backfill_import.json'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- DBシミュレーション（date→entry、同一dateは置換） ----
const db = new Map();
function apply(res) { for (const e of res.entries) db.set(e.date, e); }
function all() { return [...db.values()].sort((a, b) => a.date < b.date ? -1 : 1); }

if (!HAS_DATA) console.log('data/ が無いため受け入れ手順（1〜4,6）をスキップし、単体検証（5）のみ実行\n');
if (HAS_DATA) {
console.log('1. バックフィル取込（178件）');
const backfill = fs.readFileSync(path.join(__dirname, '../data/backfill_import.json'), 'utf8');
const r1 = L.parseImport(backfill, all());
apply(r1);
check('エラー0件', r1.errors.length === 0, JSON.stringify(r1.errors.slice(0, 3)));
check('178件取込', r1.entries.length === 178 && db.size === 178, `entries=${r1.entries.length} db=${db.size}`);
check('deep/waterキーは無視して受理', !('deep' in all()[0]) && !('water' in all()[0]));

console.log('2. 直近2日分取込');
const daily = fs.readFileSync(path.join(__dirname, '../data/daily_20260707-08.json'), 'utf8');
const r2 = L.parseImport(daily, all());
apply(r2);
check('エラー0件', r2.errors.length === 0, JSON.stringify(r2.errors));
check('エントリ数180', db.size === 180, `db=${db.size}`);

console.log('3. 2026-07-08 の回復度判定（golf緩和）');
const entries = all();
const e0708 = db.get('2026-07-08');
const rec = L.recovery(entries, e0708);
console.log(`     乖離: hrv=${rec.deviations.hrv?.toFixed(1)}% sleep=${rec.deviations.sleep?.toFixed(1)}% bb=${rec.deviations.bb?.toFixed(1)}%`);
console.log(`     n: hrv=${rec.baselines.hrv.n} sleep=${rec.baselines.sleep.n} bb=${rec.baselines.bb.n}`);
console.log(`     判定: ${rec.preRelaxLevel} → ${rec.level}（relaxed=${rec.relaxed}）`);
check('基準線n≥7（基準構築中でない）', rec.level !== 'building');
check('基準線比の実値が算出される', rec.deviations.hrv !== null && rec.deviations.sleep !== null && rec.deviations.bb !== null);
// 判定ロジック自体の整合（乖離値から独立に再計算）
const devs = ['hrv', 'sleep', 'bb'].map(m => rec.deviations[m]);
const n20 = devs.filter(d => d <= -20).length, n10 = devs.filter(d => d <= -10).length;
const expectedPre = n20 >= 2 ? 'low' : n10 >= 1 ? 'mid' : 'high';
check(`緩和前判定=${expectedPre}`, rec.preRelaxLevel === expectedPre);
if (expectedPre !== 'high') {
  check('golf交絡で1段階緩和されている', rec.relaxed === true && rec.level === (expectedPre === 'low' ? 'mid' : 'high'));
} else {
  check('緩和不要（高のまま）', rec.relaxed === false && rec.level === 'high');
}

console.log('4. export→再importで完全一致');
const exported = L.exportJSON(all());
const db2 = new Map();
const r3 = L.parseImport(exported, []);
for (const e of r3.entries) db2.set(e.date, e);
check('再importエラー0件', r3.errors.length === 0, JSON.stringify(r3.errors.slice(0, 3)));
check('件数一致(180)', db2.size === 180, `db2=${db2.size}`);
const a1 = JSON.stringify(all());
const a2 = JSON.stringify([...db2.values()].sort((a, b) => a.date < b.date ? -1 : 1));
check('全フィールド完全一致', a1 === a2);
// 再import時に浮腫の新規誤検出がないこと（edemaは保存値を維持）
check('再importで浮腫フラグが変化しない', r3.entries.every(e => e.edema === db.get(e.date).edema));

} // HAS_DATA
console.log('5. コアロジック単体検証');
// 5.1 基準線: 当日を含まない・28日窓・sick/excludeBaseline除外
{
  const es = [];
  for (let i = 1; i <= 30; i++) {
    const d = new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
    es.push({ date: d, hrv: 40, confounds: [], excludeBaseline: false });
  }
  const b = L.baseline(es, '2026-01-31', 'hrv');
  check('28日窓（1/3〜1/30の28件）', b.n === 28, `n=${b.n}`);
  es[29].confounds = ['sick']; // 1/30
  es[28].excludeBaseline = true; // 1/29
  const b2 = L.baseline(es, '2026-01-31', 'hrv');
  check('sick・excludeBaseline除外', b2.n === 26, `n=${b2.n}`);
  const b3 = L.baseline(es, '2026-01-30', 'hrv');
  check('当日を含まない', b3.n === 27, `n=${b3.n}`); // 窓=1/2〜1/29の28件、うち1/29がexcludeBaselineで27件。当日1/30(sick)は窓外
}
// 5.1b rhr懸念判定（+10%以上）: deviationPctの符号確認
{
  check('rhr +10%が算出される', Math.abs(L.deviationPct(66, 60) - 10) < 1e-9);
}
// 5.2 回復度しきい値
{
  const mk = (hrvDev, sleepDev, bbDev, confounds = []) => {
    const es = [];
    for (let i = 1; i <= 28; i++) {
      const d = new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
      es.push({ date: d, hrv: 100, sleep: 100, bb: 100, confounds: [], excludeBaseline: false });
    }
    const today = { date: '2026-01-29', hrv: 100 + hrvDev, sleep: 100 + sleepDev, bb: 100 + bbDev, confounds, excludeBaseline: false };
    return L.recovery(es.concat([today]), today);
  };
  check('全指標基準線どおり→高', mk(0, 0, 0).level === 'high');
  check('1指標-10%→中', mk(-10, 0, 0).level === 'mid');
  check('1指標-20%のみ→中', mk(-20, 0, 0).level === 'mid');
  check('2指標-20%→低', mk(-20, -20, 0).level === 'low');
  check('低+golf→中に緩和', (() => { const r = mk(-20, -20, 0, ['golf']); return r.level === 'mid' && r.relaxed; })());
  check('中+golf→高に緩和', (() => { const r = mk(-10, 0, 0, ['golf']); return r.level === 'high' && r.relaxed; })());
  check('高+golf→緩和なし', (() => { const r = mk(0, 0, 0, ['golf']); return r.level === 'high' && !r.relaxed; })());
}
// 5.3 浮腫シグネチャ
{
  const prior = [{ date: '2026-01-01', weight: 88.0, fat: 26.0, muscle: 31.0 }];
  check('体重↑脂肪↓筋↑→検出', L.detectEdema(prior, { date: '2026-01-05', weight: 88.5, fat: 25.5, muscle: 31.5 }) === true);
  check('体重↑脂肪↑→非検出', L.detectEdema(prior, { date: '2026-01-05', weight: 88.5, fat: 26.5, muscle: 31.5 }) === false);
  check('3値不揃い→非検出', L.detectEdema(prior, { date: '2026-01-05', weight: 88.5, fat: null, muscle: 31.5 }) === false);
}
// 5.4 バリデーション
{
  const r = L.parseImport(JSON.stringify([
    { date: '2026-01-01', hrv: 40 },
    { date: 'bad-date', hrv: 40 },
    { date: '2026-01-02', mood: 9 },
    { date: '2026-01-03', hrv: 'abc' },
    { date: '2026-01-04', hrv: 41, deep: 55, water: 60 },
  ]), []);
  check('有効2件・エラー3件', r.entries.length === 2 && r.errors.length === 3, `e=${r.entries.length} err=${r.errors.length}`);
  check('mood範囲エラー検出', r.errors.some(e => e.reason.includes('mood')));
  check('deep/water付きも受理', r.entries.some(e => e.date === '2026-01-04'));
}
// 5.5 気分トラック
{
  const es = [];
  for (let i = 1; i <= 10; i++) {
    const d = new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
    es.push({ date: d, mood: 4, hrv: 100, sleep: 100, bb: 100, confounds: [], excludeBaseline: false });
  }
  const today = { date: '2026-01-11', mood: 2, hrv: 100, sleep: 100, bb: 100, confounds: [], excludeBaseline: false };
  const mt = L.moodTrack(es.concat([today]), today, 'high');
  check('mood乖離pt（4基準で2→-2.0pt）', Math.abs(mt.deviationPt - (-2)) < 1e-9, `dev=${mt.deviationPt}`);
  check('回復度高×気分基準以下→フラグ', mt.flag !== null);
  const mt2 = L.moodTrack(es.concat([today]), { ...today, mood: 5 }, 'low');
  check('回復度低×気分良好→フラグ', mt2.flag !== null);
  const es7 = es.slice(0, 5);
  const mt3 = L.moodTrack(es7.concat([today]), today, 'high');
  check('n<7でフラグ沈黙・基準構築中', mt3.building === true && mt3.flag === null, `n=${mt3.baseline.n}`);
}

// 5.6 v1.1 信号・総合状態・コメント
{
  const mkE = (n, base, today) => {
    const es = [];
    for (let i = 1; i <= n; i++) {
      const d = new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
      es.push({ date: d, hrv: base, rhr: 60, sleep: base, bb: base, weight: 88, fat: 26, muscle: 31, confounds: [], excludeBaseline: false });
    }
    const e = Object.assign({ date: '2026-01-29', rhr: 60, confounds: [], excludeBaseline: false }, today);
    return { es: es.concat([e]), e };
  };
  check('信号: 青(-5%)', L.signal(-5, false) === 'blue');
  check('信号: 黄(-10%)', L.signal(-10, false) === 'yellow');
  check('信号: 赤(-20%)', L.signal(-20, false) === 'red');
  check('信号rhr反転: 黄(+5%)', L.signal(5, true) === 'yellow');
  check('信号rhr反転: 赤(+10%)', L.signal(10, true) === 'red');
  {
    const { es, e } = mkE(28, 100, { hrv: 100, sleep: 100, bb: 100 });
    check('総合状態: 平常(乖離0)', L.condition(es, e).state === 'normal');
  }
  {
    const { es, e } = mkE(28, 100, { hrv: 108, sleep: 106, bb: 107 });
    const c = L.condition(es, e);
    check('総合状態: 好調(全青・平均+7%)', c.state === 'good', c.state);
  }
  {
    const { es, e } = mkE(28, 100, { hrv: 85, sleep: 100, bb: 100 });
    check('総合状態: 不調(回復度中)', L.condition(es, e).state === 'bad');
  }
  {
    const { es, e } = mkE(28, 100, { hrv: 85, sleep: 100, bb: 100, confounds: ['golf'] });
    const c = L.condition(es, e);
    check('総合状態: golf緩和で中→高なら平常', c.state === 'normal' && c.recovery.relaxed);
  }
  {
    const { es, e } = mkE(5, 100, { hrv: 100, sleep: 100, bb: 100 });
    check('総合状態: n<7で判定保留', L.condition(es, e).state === 'building');
  }
  {
    const { es, e } = mkE(28, 100, { hrv: 108, sleep: 106, bb: null });
    check('総合状態: 当日値欠けは好調にしない', L.condition(es, e).state === 'normal');
  }
  {
    const { es, e } = mkE(28, 100, { hrv: 100, sleep: 100, bb: 100, weight: 88.0, fat: 26.0 });
    const cm = L.comments(es, e, { goalWeight: 85.0 });
    check('コメント: 体調文生成', cm.condition.includes('基準線圏内'), cm.condition);
    check('コメント: 体重に目標差', cm.weight.includes('残り3.0kg'), cm.weight);
    check('コメント: 体脂肪率文生成', cm.fat.startsWith('26.0%'), cm.fat);
    const cm2 = L.comments(es, e, {});
    check('コメント: 目標未設定なら言及なし', !cm2.weight.includes('目標'));
  }
  {
    const tr = L.windowTrend(
      Array.from({ length: 56 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
        weight: i < 28 ? 89 : 88
      })), '2026-02-25', 'weight');
    check('推移: 前28日比 -1.0kg', tr && Math.abs(tr.diff - (-1)) < 1e-9, JSON.stringify(tr));
  }
}

if (HAS_DATA) {
  const entries2 = all();
  console.log('6. 状態ヘッダー全文（2026-07-08・目視確認用）');
  console.log(L.statusHeaderText(entries2, db.get('2026-07-08')).split('\n').map(l => '     ' + l).join('\n'));
}

console.log(`\n結果: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
