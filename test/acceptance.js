/* 受け入れ手順（要件§7）＋コアロジックの単体検証。node test/acceptance.js で実行 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('../docs/logic.js');
// 実測データ（data/ は個人健康データのためgitignore。手元にない場合は受け入れ手順部分をスキップ）
const HAS_DATA = fs.existsSync(path.join(__dirname, '../data/import/backfill_import.json'));

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
const backfill = fs.readFileSync(path.join(__dirname, '../data/import/backfill_import.json'), 'utf8');
const r1 = L.parseImport(backfill, all());
apply(r1);
check('エラー0件', r1.errors.length === 0, JSON.stringify(r1.errors.slice(0, 3)));
check('178件取込', r1.entries.length === 178 && db.size === 178, `entries=${r1.entries.length} db=${db.size}`);
check('deep/waterキーは無視して受理', !('deep' in all()[0]) && !('water' in all()[0]));

console.log('2. 直近2日分取込');
const daily = fs.readFileSync(path.join(__dirname, '../data/import/daily_20260707-08.json'), 'utf8');
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

// 5.7 マージ取込（2026-08-10改訂・取込タブの既定動作）
{
  const existing = [{
    date: '2026-08-01', hrv: 40, rhr: 55, sleep: 80, bb: 70,
    weight: 88.0, mood: 4, fat: 26.0, muscle: 31.0, visceral: 10,
    confounds: ['golf'], excludeBaseline: false, edema: false, note: '手入力メモ'
  }];
  const incoming = JSON.stringify([{
    date: '2026-08-01', hrv: 42, rhr: null, sleep: 82, bb: null,
    weight: null, mood: null, fat: null, muscle: null, visceral: null,
    confounds: [], excludeBaseline: false, edema: false, note: ''
  }]);
  const rm = L.parseImport(incoming, existing, { merge: true });
  const m = rm.entries[0];
  check('マージ: 非null値は上書き（hrv 40→42, sleep 80→82）', m.hrv === 42 && m.sleep === 82);
  check('マージ: null値は既存保持（rhr=55, bb=70）', m.rhr === 55 && m.bb === 70);
  check('マージ: mood・体組成の手入力を保全', m.mood === 4 && m.weight === 88.0 && m.fat === 26.0 && m.muscle === 31.0 && m.visceral === 10);
  check('マージ: 空confounds・空noteは既存保持', m.confounds.length === 1 && m.confounds[0] === 'golf' && m.note === '手入力メモ');
  const rr = L.parseImport(incoming, existing); // オプションなし＝従来の置換
  const p = rr.entries[0];
  check('置換（既定オプションなし）: 従来どおり丸ごと差し替え', p.rhr === null && p.mood === null && p.weight === null && p.confounds.length === 0);
  const rf = L.parseImport(JSON.stringify([{ date: '2026-08-01', excludeBaseline: true, edema: true }]), existing, { merge: true });
  check('マージ: excludeBaseline/edemaはOR（trueが残る）', rf.entries[0].excludeBaseline === true && rf.entries[0].edema === true);
  const rf2 = L.parseImport(incoming, [{ ...existing[0], excludeBaseline: true, edema: true }], { merge: true });
  check('マージ: 既存trueフラグはincoming falseで消えない', rf2.entries[0].excludeBaseline === true && rf2.entries[0].edema === true);
  const rn = L.parseImport(JSON.stringify([{ date: '2026-08-02', hrv: 44 }]), existing, { merge: true });
  check('マージ: 既存にない日付は新規としてそのまま入る', rn.entries[0].date === '2026-08-02' && rn.entries[0].hrv === 44 && rn.entries[0].mood === null);
  // マージ後の値で浮腫検出が働くこと（既存の体組成＋当日のweightだけ来た場合は3値が揃い検出対象になる）
  const prior = [{ date: '2026-07-31', weight: 88.0, fat: 26.0, muscle: 31.0, confounds: [], excludeBaseline: false, edema: false, note: '' }];
  const ex2 = prior.concat([{ date: '2026-08-01', weight: null, fat: 25.5, muscle: 31.5, hrv: null, rhr: null, sleep: null, bb: null, mood: null, visceral: null, confounds: [], excludeBaseline: false, edema: false, note: '' }]);
  const re = L.parseImport(JSON.stringify([{ date: '2026-08-01', weight: 88.5 }]), ex2, { merge: true });
  check('マージ: マージ後の3値で浮腫シグネチャ検出', re.entries[0].edema === true && re.edemaDetected.includes('2026-08-01'));
}

// 5.8 v1.4.0 減量モニタリング（後方互換スキーマ＋判定ロジック・合成データ）
console.log('5.8 減量モニタリング（v1.4.0）');
{
  const base = { hrv: null, rhr: null, sleep: null, bb: null, weight: null, mood: null, fat: null, muscle: null, visceral: null, confounds: [], excludeBaseline: false, edema: false, note: '' };
  const dstr = n => new Date(Date.UTC(2026, 7, 1) + n * 86400000).toISOString().slice(0, 10); // 2026-08-01 + n日
  const mk = (n, o) => ({ ...base, date: dstr(n), ...o });

  // --- スキーマ後方互換 ---
  const rOld = L.parseImport(JSON.stringify([{ date: '2026-08-01', hrv: 40, weight: 88 }]), []);
  check('旧JSON（新キーなし）は新5フィールドnullで受理', ['steps', 'kcalOut', 'kcalActive', 'kcalIn', 'protein'].every(k => rOld.entries[0][k] === null));
  const rNew = L.parseImport(JSON.stringify([{ date: '2026-08-01', steps: 8000, kcalOut: 2400, kcalActive: 300, kcalIn: 1900, protein: 150 }]), []);
  const en = rNew.entries[0];
  check('新キー付きJSONを取込・保持', en.steps === 8000 && en.kcalOut === 2400 && en.kcalActive === 300 && en.kcalIn === 1900 && en.protein === 150);
  const back = L.parseImport(L.exportJSON(rNew.entries), []);
  check('export→再importで新キー往復一致', JSON.stringify(back.entries[0]) === JSON.stringify(en));
  check('旧エントリ（新キー未定義）のexportはnullで出力', JSON.parse(L.exportJSON([{ ...base, date: '2026-08-01' }]))[0].steps === null);
  check('数値でない新キーはエラー', L.parseImport(JSON.stringify([{ date: '2026-08-01', kcalIn: 'abc' }]), []).errors.length === 1);
  // クイック入力（減量タブ）はマージで自動取得値を保全、自動JSON（kcalIn null）は手入力を保全
  const ex = [mk(0, { hrv: 40, steps: 9000, kcalOut: 2500 })];
  const q = L.parseImport(JSON.stringify([{ date: dstr(0), kcalIn: 1800, protein: 140 }]), ex, { merge: true }).entries[0];
  check('クイック入力マージ: hrv/steps/kcalOutを保全しkcalIn/proteinを追加', q.hrv === 40 && q.steps === 9000 && q.kcalOut === 2500 && q.kcalIn === 1800 && q.protein === 140);
  const a = L.parseImport(JSON.stringify([{ ...base, date: dstr(0), steps: 9500, kcalOut: 2550 }]), [q], { merge: true }).entries[0];
  check('自動JSON再取込（kcalIn null）で手入力kcalIn/proteinを保全・活動量は更新', a.kcalIn === 1800 && a.protein === 140 && a.steps === 9500);
  check('monthlySummary TSV見出しに新列', L.monthlySummary([q], '2026-08').includes('\tsteps\tkcalOut\tkcalActive\tkcalIn\tprotein\t'));

  // --- ペース判定（2日おき測定・28日窓＝当日含む） ---
  const series = (slopePerDay, opts) => {
    const arr = [];
    for (let n = 0; n <= 27; n += 2) arr.push(mk(n, { weight: +(88 - slopePerDay * n).toFixed(2), ...(opts && opts.extra ? opts.extra(n) : {}) }));
    return arr;
  };
  const end = dstr(27);
  const st = (arr, o) => L.weightLossStatus(arr, end, o || {});
  check('ペース good（−0.3kg/週）', st(series(0.3 / 7)).pace.state === 'good', JSON.stringify(st(series(0.3 / 7)).pace));
  check('ペース fast（−0.7kg/週）', st(series(0.7 / 7)).pace.state === 'fast');
  check('ペース stall（0kg/週）', st(series(0)).pace.state === 'stall');
  check('ペース gain（+0.3kg/週）', st(series(-0.3 / 7)).pace.state === 'gain');
  check('ペース 勾配の値（−0.3kg/週）', Math.abs(st(series(0.3 / 7)).pace.slopeKgWeek - (-0.3)) < 0.02);
  const few = series(0.3 / 7).slice(0, 4);
  check('ペース insufficient（n=4）', st(few).pace.state === 'insufficient' && st(few).pace.n === 4);
  const span = [mk(20, { weight: 88 }), mk(21, { weight: 87.9 }), mk(22, { weight: 87.8 }), mk(23, { weight: 87.7 }), mk(24, { weight: 87.6 }), mk(25, { weight: 87.5 }), mk(27, { weight: 87.4 })];
  check('ペース insufficient（n=7でも期間<14日）', st(span).pace.state === 'insufficient');
  const withEdema = series(0.3 / 7).concat([mk(13, { weight: 92, fat: 20, muscle: 35, edema: true })]).sort((x, y) => x.date < y.date ? -1 : 1);
  check('ペース: 浮腫日の外れ値（92kg）は無視', st(withEdema).pace.state === 'good' && st(withEdema).pace.n === 14);
  const withExcl = series(0.3 / 7).concat([mk(13, { weight: 92, excludeBaseline: true })]).sort((x, y) => x.date < y.date ? -1 : 1);
  check('ペース: 基準線除外日の外れ値は無視', st(withExcl).pace.state === 'good');
  // 月次ルール: 前28日が90.5kg一定・直近28日が88kg一定（勾配0だが差 −2.5kg）→ fast
  const monthly = [];
  for (let n = -28; n <= 27; n += 2) monthly.push(mk(n, { weight: n < 0 ? 90.5 : 88 }));
  const ms = st(monthly);
  check('月次ルール: 28日平均差 −2.5kg で monthlyFast → fast', ms.pace.monthlyFast === true && ms.pace.state === 'fast', JSON.stringify(ms.pace));
  check('目標差: goalWeight 85 で remaining 3.0', Math.abs(st(series(0), { goalWeight: 85 }).remaining - 3) < 1e-9);

  // --- 体組成の質 ---
  const comp = (fatRecent, fatPrior, wRecent, wPrior) => {
    const arr = [];
    for (let n = -28; n <= 27; n += 3) arr.push(mk(n, { weight: n < 0 ? wPrior : wRecent, fat: n < 0 ? fatPrior : fatRecent }));
    return st(arr).composition;
  };
  // 前: 90kg×27% = 脂肪24.3/除脂肪65.7、後: 89kg×26% = 23.14/65.86 → 脂肪−1.16・除脂肪+0.16
  check('体組成 good（脂肪↓・除脂肪維持）', comp(26, 27, 89, 90).state === 'good', JSON.stringify(comp(26, 27, 89, 90)));
  // 前: 90×27% = 24.3/65.7、後: 88×27% = 23.76/64.24 → 脂肪−0.54・除脂肪−1.46
  check('体組成 lean_loss（脂肪↓・除脂肪↓）', comp(27, 27, 88, 90).state === 'lean_loss');
  // 前: 88×26% = 22.88、後: 89×27% = 24.03 → 脂肪+1.15
  check('体組成 fat_gain', comp(27, 26, 89, 88).state === 'fat_gain');
  check('体組成 flat', comp(27, 27, 90, 90).state === 'flat');
  check('体組成 insufficient（体脂肪率なし）', st(series(0.3 / 7)).composition.state === 'insufficient');

  // --- 収支・タンパク質 ---
  const energy = (kin, kout, prot, days) => {
    const arr = [];
    for (let n = 27 - (days - 1); n <= 27; n++) arr.push(mk(n, { kcalIn: kin, kcalOut: kout, protein: prot }));
    return st(arr).energy;
  };
  const e500 = energy(1900, 2400, 150, 7);
  check('収支 on（赤字500）・理論ペース≈−0.45kg/週', e500.state === 'on' && Math.abs(e500.expectedKgWeek - (-500 * 7 / 7700)) < 1e-9);
  check('収支 below（赤字200）', energy(2200, 2400, 150, 7).state === 'below');
  check('収支 above（赤字900）', energy(1500, 2400, 150, 7).state === 'above');
  check('収支 insufficient（n=2）', energy(1900, 2400, 150, 2).state === 'insufficient');
  check('タンパク質 ok（150g）/ low（100g）', e500.protein.state === 'ok' && energy(1900, 2400, 100, 7).protein.state === 'low');
  const e7 = []; for (let n = 21; n <= 27; n++) e7.push(mk(n, { kcalIn: 1900, kcalOut: 2400 }));
  check('収支目標の上書き（deficitTarget 300 で赤字500は above）', st(e7, { deficitTarget: 300 }).energy.state === 'above');

  // --- 活動量 ---
  const act = (recent, baseSteps) => {
    const arr = [];
    for (let n = -7; n <= 20; n++) arr.push(mk(n, { steps: baseSteps }));  // 基準線（当日を含まない直近28日）
    for (let n = 21; n <= 27; n++) arr.push(mk(n, { steps: recent }));
    return st(arr).activity;
  };
  check('活動量 up（7日平均 +20%）', act(12000, 10000).state === 'up', JSON.stringify(act(12000, 10000)));
  check('活動量 down（−20%）', act(8000, 10000).state === 'down');
  check('活動量 flat', act(10500, 10000).state === 'flat');
  const actFew = (() => { const arr = []; for (let n = 21; n <= 27; n++) arr.push(mk(n, { steps: 10000 })); return st(arr).activity; })();
  check('活動量 insufficient（基準線n<7）', actFew.state === 'insufficient');

  // --- 全文テキスト・移動平均 ---
  const txt = L.weightLossText(series(0.3 / 7), end, { goalWeight: 85 });
  check('weightLossText: 見出しと目標行', txt.startsWith(`【減量モニター ${end}】`) && txt.includes('目標85.0kgまで残り'));
  const ma = L.movingAverageSeries(series(0), end, 'weight', 4, 7);
  check('movingAverageSeries: 4週分・値がある日のみ・平均88', ma.length > 0 && ma.every(p => Math.abs(p.y - 88) < 1e-9) && ma[ma.length - 1].x === 27);
  const maEd = L.movingAverageSeries(withEdema, end, 'weight', 4, 7);
  check('movingAverageSeries: 浮腫日は算入しない', maEd.every(p => p.y < 90));
}

// 5.9 v1.5.0 自動同期（sync.js: 設定文字列・暗号化エンベロープ・取得結果の分類）
console.log('5.9 自動同期（v1.5.0）');
const S = require('../docs/sync.js');
(async () => {
  const key = S.bytesToB64url(require('crypto').webcrypto.getRandomValues(new Uint8Array(32)));
  const setup = `rfsync1:fugangliang/rf-tracker-data:${key}`;
  const ps = S.parseSetup(setup);
  check('parseSetup: 正常な設定文字列を解釈', ps && ps.repo === 'fugangliang/rf-tracker-data' && ps.key === key);
  check('parseSetup: 前後の空白を許容', !!S.parseSetup('  ' + setup + '\n'));
  check('parseSetup: 不正（鍵長違い・接頭辞違い）は null', S.parseSetup('rfsync1:a/b:short') === null && S.parseSetup('rfsync2:a/b:' + key) === null && S.parseSetup('') === null);
  const plain = JSON.stringify([{ date: '2026-09-01', hrv: 33, kcalIn: 1800, note: '同期テスト日本語' }]);
  const env = await S.encryptEnvelope(plain, key, '2026-09-08T00:31:00+00:00');
  check('encryptEnvelope: エンベロープ形式（v1・AES-256-GCM・iv/ct/updated）', env.v === 1 && env.alg === 'AES-256-GCM' && S.b64urlToBytes(env.iv).length === 12 && typeof env.ct === 'string' && env.updated === '2026-09-08T00:31:00+00:00');
  check('decryptEnvelope: 往復一致（オブジェクト／JSON文字列の両方）', await S.decryptEnvelope(env, key) === plain && await S.decryptEnvelope(JSON.stringify(env), key) === plain);
  let bad = false;
  try { await S.decryptEnvelope(env, S.bytesToB64url(new Uint8Array(32))); } catch (e) { bad = true; }
  check('decryptEnvelope: 鍵違いは失敗', bad);
  let tampered = false;
  try { await S.decryptEnvelope({ ...env, ct: env.ct.slice(0, -2) + 'AA' }, key); } catch (e) { tampered = true; }
  check('decryptEnvelope: 改ざんは失敗（GCMタグ）', tampered);
  check('復号結果は parseImport(merge) でそのまま取込可', L.parseImport(await S.decryptEnvelope(env, key), [], { merge: true }).entries[0].kcalIn === 1800);
  const mk = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, text: async () => body });
  check('fetchEnvelope: 200 → envelope', (await S.fetchEnvelope('o/r', 't', mk(200, JSON.stringify(env)))).ok === true);
  check('fetchEnvelope: 401/403 → auth', (await S.fetchEnvelope('o/r', 't', mk(401, ''))).reason === 'auth' && (await S.fetchEnvelope('o/r', 't', mk(403, ''))).reason === 'auth');
  check('fetchEnvelope: 404 → notfound', (await S.fetchEnvelope('o/r', 't', mk(404, ''))).reason === 'notfound');
  check('fetchEnvelope: 例外 → network', (await S.fetchEnvelope('o/r', 't', async () => { throw new Error('x'); })).reason === 'network');
  let hdr = null;
  await S.fetchEnvelope('o/r', 'tok', async (url, init) => { hdr = { url, ...init.headers }; return { status: 404, ok: false, text: async () => '' }; });
  check('fetchEnvelope: Contents API URL・raw Accept・Bearer', hdr.url === 'https://api.github.com/repos/o/r/contents/data.enc' && hdr.Accept === 'application/vnd.github.raw+json' && hdr.Authorization === 'Bearer tok');

  if (HAS_DATA) {
    const entries2 = all();
    console.log('6. 状態ヘッダー全文（2026-07-08・目視確認用）');
    console.log(L.statusHeaderText(entries2, db.get('2026-07-08')).split('\n').map(l => '     ' + l).join('\n'));
  }
  console.log(`\n結果: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
