/* RF基準線トラッカー コアロジック（要件定義書 v1.0 §4 準拠・現行v1.2移植）
 * 純関数のみ。ブラウザ(window.RFLogic)とNode(module.exports)の両方で動く。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RFLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NUMERIC_FIELDS = ['hrv', 'rhr', 'sleep', 'bb', 'weight', 'mood', 'fat', 'muscle', 'visceral'];
  const CONFOUNDS = ['alcohol', 'golf', 'travel', 'sick'];
  const IGNORED_KEYS = ['deep', 'water']; // v1.0旧スキーマ互換: 無視して受理
  const BASELINE_DAYS = 28;
  const MIN_N = 7;

  // ---- 日付ユーティリティ（UTC固定でDST非依存） ----
  function dateToNum(dateStr) {
    return Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) / 86400000;
  }
  function isValidDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }

  // ---- 基準線計算からの除外判定（§4.1） ----
  function isExcludedFromBaseline(entry) {
    return entry.excludeBaseline === true ||
      (Array.isArray(entry.confounds) && entry.confounds.includes('sick'));
  }

  /* §4.1 28日移動基準線: 当日を含まない直近28日（暦日）の有効値から mean/sd/n */
  function baseline(entries, dateStr, metric) {
    const end = dateToNum(dateStr); // exclusive
    const start = end - BASELINE_DAYS;
    const vals = [];
    for (const e of entries) {
      const d = dateToNum(e.date);
      if (d < start || d >= end) continue;
      if (isExcludedFromBaseline(e)) continue;
      const v = e[metric];
      if (typeof v === 'number' && isFinite(v)) vals.push(v);
    }
    const n = vals.length;
    if (n === 0) return { mean: null, sd: null, n: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { mean, sd, n };
  }

  /* 乖離% = (当日値 − 基準線平均) / 基準線平均 × 100 */
  function deviationPct(value, mean) {
    if (typeof value !== 'number' || typeof mean !== 'number' || mean === 0) return null;
    return (value - mean) / mean * 100;
  }

  /* §4.2 回復度判定。判定3指標: hrv/sleep/bb。rhrは含めない。
   * 返り値: { level: 'high'|'mid'|'low'|'building', relaxed: bool,
   *           preRelaxLevel, deviations: {hrv,sleep,bb}, baselines, building: [metric] } */
  function recovery(entries, entry) {
    const metrics = ['hrv', 'sleep', 'bb'];
    const baselines = {}, deviations = {}, building = [];
    for (const m of metrics) {
      const b = baseline(entries, entry.date, m);
      baselines[m] = b;
      deviations[m] = deviationPct(entry[m], b.mean);
      if (b.n < MIN_N) building.push(m);
    }
    if (building.length > 0) {
      return { level: 'building', relaxed: false, preRelaxLevel: null, deviations, baselines, building };
    }
    const devs = metrics.map(m => deviations[m]).filter(d => d !== null);
    const nLow20 = devs.filter(d => d <= -20).length;
    const nLow10 = devs.filter(d => d <= -10).length;
    let level = 'high';
    if (nLow20 >= 2) level = 'low';
    else if (nLow10 >= 1) level = 'mid';
    // 交絡緩和: golf の日は1段階緩和（低→中、中→高）
    let relaxed = false;
    const preRelaxLevel = level;
    if (Array.isArray(entry.confounds) && entry.confounds.includes('golf') && level !== 'high') {
      level = level === 'low' ? 'mid' : 'high';
      relaxed = true;
    }
    return { level, relaxed, preRelaxLevel, deviations, baselines, building };
  }

  /* §4.3 故障モード予報（固定文言） */
  const FAILURE_MODES = {
    high: { label: '高', mode: '特記なし', protocol: '—', sensitivity: '標準' },
    mid: {
      label: '中',
      mode: '網羅要求の過剰化（判断を変えない情報収集への逃避）／問いの先鋭化低下',
      protocol: '着手前に『この情報で判断は変わるか』を1問挟む。重要案件は午前に前倒し',
      sensitivity: '標準'
    },
    low: {
      label: '低',
      mode: 'ラベル語彙の出現（対人センサー凍結）／顔色窺いモード／承認渇望への脆弱化',
      protocol: '警告灯感度『高』。重要な対人判断・不可逆な意思決定は延期を検討。幹部評価系の文書作成は禁止推奨',
      sensitivity: '高'
    },
    building: { label: '基準構築中', mode: '—', protocol: '—', sensitivity: '標準' }
  };

  /* §4.4 気分トラック。乖離はpt表示。n<7は基準構築中でフラグ沈黙。
   * 主観-客観乖離フラグ: 「基準以下」= 当日mood < 基準線平均, 「良好」= 当日mood > 基準線平均 */
  function moodTrack(entries, entry, recoveryLevel) {
    const b = baseline(entries, entry.date, 'mood');
    const result = { baseline: b, deviationPt: null, flag: null, building: b.n < MIN_N };
    if (typeof entry.mood === 'number' && b.mean !== null) {
      result.deviationPt = entry.mood - b.mean;
    }
    if (!result.building && typeof entry.mood === 'number' && b.mean !== null) {
      if (recoveryLevel === 'high' && entry.mood < b.mean) {
        result.flag = 'センサーが拾わない消耗の可能性、対人判断は慎重に';
      } else if (recoveryLevel === 'low' && entry.mood > b.mean) {
        result.flag = '負荷は数値どおり残存、過大評価に注意';
      }
    }
    return result;
  }

  /* §4.5 浮腫シグネチャ自動検出。
   * entriesは当日より前の全エントリ（日付昇順）。当日にweight/fat/muscleが揃い、
   * 直近の3値が揃う日と比べ 体重↑かつ体脂肪率↓かつ骨格筋率↑ で edema。 */
  function detectEdema(priorEntries, entry) {
    const hasAll = e => ['weight', 'fat', 'muscle'].every(k => typeof e[k] === 'number');
    if (!hasAll(entry)) return false;
    const today = dateToNum(entry.date);
    let prev = null;
    for (const e of priorEntries) {
      if (dateToNum(e.date) >= today) continue;
      if (hasAll(e) && (prev === null || dateToNum(e.date) > dateToNum(prev.date))) prev = e;
    }
    if (!prev) return false;
    return entry.weight > prev.weight && entry.fat < prev.fat && entry.muscle > prev.muscle;
  }

  /* §4.6 インポート: 単一オブジェクトまたは配列。日付昇順処理。エラー行スキップ。
   * existingEntries: DB内の既存エントリ（浮腫検出の前日参照に使用）。
   * 返り値: { entries: 正規化済みエントリ[], errors: [{index, date, reason}], edemaDetected: [date] } */
  function parseImport(jsonText, existingEntries) {
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      return { entries: [], errors: [{ index: null, date: null, reason: 'JSONとして解釈できません: ' + e.message }], edemaDetected: [] };
    }
    if (!Array.isArray(data)) data = [data];

    const errors = [];
    const rows = [];
    data.forEach((raw, i) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ index: i, date: null, reason: 'オブジェクトではありません' });
        return;
      }
      if (!isValidDateStr(raw.date)) {
        errors.push({ index: i, date: raw.date ?? null, reason: 'dateが欠落または不正（YYYY-MM-DD必須）' });
        return;
      }
      const e = { date: raw.date };
      let bad = null;
      for (const f of NUMERIC_FIELDS) {
        const v = raw[f];
        if (v === undefined || v === null) { e[f] = null; continue; }
        if (typeof v !== 'number' || !isFinite(v)) { bad = `${f} が数値ではありません`; break; }
        if (f === 'mood' && (v < 1 || v > 5)) { bad = `mood が範囲外（1〜5）: ${v}`; break; }
        e[f] = v;
      }
      if (bad) { errors.push({ index: i, date: raw.date, reason: bad }); return; }
      if (raw.confounds !== undefined && raw.confounds !== null && !Array.isArray(raw.confounds)) {
        errors.push({ index: i, date: raw.date, reason: 'confounds が配列ではありません' });
        return;
      }
      e.confounds = Array.isArray(raw.confounds) ? raw.confounds.filter(c => CONFOUNDS.includes(c)) : [];
      e.excludeBaseline = raw.excludeBaseline === true;
      e.edema = raw.edema === true;
      e.note = typeof raw.note === 'string' ? raw.note : '';
      // deep / water（IGNORED_KEYS）は無視して受理
      rows.push(e);
    });

    // 日付昇順に処理（浮腫自動検出が前日値に依存）。同一dateは上書き（後勝ち・置換）
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const map = new Map((existingEntries || []).map(e => [e.date, e]));
    const edemaDetected = [];
    for (const e of rows) {
      const prior = [...map.values()];
      if (!e.edema && detectEdema(prior, e)) {
        e.edema = true;
        edemaDetected.push(e.date);
      }
      map.set(e.date, e); // 置換（マージではない）
    }
    const entries = rows; // 正規化済み・昇順（同一date重複は後で置換適用側が処理）
    return { entries, errors, edemaDetected };
  }

  /* エクスポート（§F6）: インポート形式と同一スキーマのJSON文字列 */
  function exportJSON(entries) {
    const sorted = [...entries].sort((a, b) => a.date < b.date ? -1 : 1);
    const out = sorted.map(e => ({
      date: e.date, hrv: e.hrv, rhr: e.rhr, sleep: e.sleep, bb: e.bb,
      weight: e.weight, mood: e.mood, fat: e.fat, muscle: e.muscle,
      visceral: e.visceral, confounds: e.confounds,
      excludeBaseline: e.excludeBaseline, edema: e.edema, note: e.note
    }));
    return JSON.stringify(out, null, 1);
  }

  /* 状態ヘッダー全文テキスト（§F3 コピー機能・レーンA携行用） */
  function statusHeaderText(entries, entry, opts) {
    const r = recovery(entries, entry);
    const fm = FAILURE_MODES[r.level];
    const mood = moodTrack(entries, entry, r.level);
    const cond = condition(entries, entry);
    const cmt = comments(entries, entry, opts);
    const sig = m => cond.signals[m] ? SIGNAL_LABELS[cond.signals[m]] + '信号' : '—';
    const fmtDev = (m, label, unit) => {
      const v = entry[m], b = r.baselines[m], d = r.deviations[m];
      if (typeof v !== 'number') return `${label}: — (基準線 ${b.mean !== null ? b.mean.toFixed(1) : '—'}${unit})`;
      const ds = d !== null ? `${d >= 0 ? '+' : ''}${d.toFixed(1)}%` : '—';
      return `${label}: ${sig(m)} ${v}${unit} (基準線比 ${ds}, n=${b.n}/${BASELINE_DAYS})`;
    };
    const lines = [];
    lines.push(`【状態ヘッダー ${entry.date}】`);
    lines.push(`状態: ${CONDITION_LABELS[cond.state]}${cond.avgDev !== null ? `（3指標平均乖離 ${cond.avgDev >= 0 ? '+' : ''}${cond.avgDev.toFixed(1)}%）` : ''}`);
    if (r.level === 'building') {
      lines.push(`回復度: 基準構築中（n<7: ${r.building.join(', ')}）`);
    } else {
      let lvl = `回復度: ${fm.label}`;
      if (r.relaxed) lvl += `（golf交絡緩和: ${FAILURE_MODES[r.preRelaxLevel].label}→${fm.label}）`;
      lines.push(lvl);
    }
    lines.push(fmtDev('hrv', 'HRV', 'ms'));
    lines.push(fmtDev('sleep', '睡眠', ''));
    lines.push(fmtDev('bb', 'BB', ''));
    const rb = cond.rhrBaseline;
    const rd = cond.rhrDev;
    if (typeof entry.rhr === 'number') {
      lines.push(`安静時心拍: ${sig('rhr')} ${entry.rhr}bpm (基準線比 ${rd !== null ? (rd >= 0 ? '+' : '') + rd.toFixed(1) + '%' : '—'}${rd !== null && rd >= 10 ? ' ⚠懸念' : ''})`);
    }
    lines.push(`予測故障モード: ${fm.mode}`);
    lines.push(`プロトコル: ${fm.protocol}`);
    lines.push(`警告灯感度: ${fm.sensitivity}`);
    if (mood.building) {
      lines.push(`気分: ${typeof entry.mood === 'number' ? entry.mood : '—'} / 基準構築中(n=${mood.baseline.n})`);
    } else if (typeof entry.mood === 'number' && mood.baseline.mean !== null) {
      lines.push(`気分: ${entry.mood} (基準${mood.baseline.mean.toFixed(1)}比 ${mood.deviationPt >= 0 ? '+' : ''}${mood.deviationPt.toFixed(1)}pt)`);
    } else {
      lines.push('気分: —');
    }
    if (mood.flag) lines.push(`⚠ 主観-客観乖離: ${mood.flag}`);
    if (entry.edema) lines.push('⚠ 浮腫フラグ: 体組成値は割り引いて解釈');
    if (Array.isArray(entry.confounds) && entry.confounds.length) lines.push(`交絡: ${entry.confounds.join(', ')}`);
    lines.push(`体調: ${cmt.condition}`);
    lines.push(`体重: ${cmt.weight}`);
    lines.push(`体脂肪率: ${cmt.fat}`);
    return lines.join('\n');
  }

  /* ===== v1.1 表示レイヤー追加（コアロジック§4は不変更） ===== */

  /* 信号判定。hrv/sleep/bb: 青 >−10% / 黄 ≤−10% / 赤 ≤−20%（回復度しきい値と同一）
   * reversed(rhr): 青 <+5% / 黄 ≥+5% / 赤 ≥+10% */
  function signal(dev, reversed) {
    if (dev === null) return null;
    if (reversed) return dev >= 10 ? 'red' : dev >= 5 ? 'yellow' : 'blue';
    return dev <= -20 ? 'red' : dev <= -10 ? 'yellow' : 'blue';
  }

  /* 総合状態: 不調(bad)/平常(normal)/好調(good)/判定保留(building)
   * 不調: 回復度（golf緩和後）が中または低
   * 好調: 回復度高・3指標とも当日値ありで青・平均乖離≥+5%
   * 平常: その他 */
  function condition(entries, entry) {
    const r = recovery(entries, entry);
    const signals = {};
    for (const m of ['hrv', 'sleep', 'bb']) signals[m] = signal(r.deviations[m], false);
    const rb = baseline(entries, entry.date, 'rhr');
    const rhrDev = deviationPct(entry.rhr, rb.mean);
    signals.rhr = signal(rhrDev, true);
    if (r.level === 'building') return { state: 'building', recovery: r, signals, avgDev: null, rhrDev, rhrBaseline: rb };
    const devs = ['hrv', 'sleep', 'bb'].map(m => r.deviations[m]).filter(d => d !== null);
    const avgDev = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null;
    let state = 'normal';
    if (r.level === 'low' || r.level === 'mid') state = 'bad';
    else if (devs.length === 3 && avgDev >= 5 && ['hrv', 'sleep', 'bb'].every(m => signals[m] === 'blue')) state = 'good';
    return { state, recovery: r, signals, avgDev, rhrDev, rhrBaseline: rb };
  }

  const CONDITION_LABELS = { good: '好調', normal: '平常', bad: '不調', building: '判定保留（基準構築中）' };
  const SIGNAL_LABELS = { blue: '青', yellow: '黄', red: '赤' };

  /* 直近28日平均と前28日平均の差（推移コメント用）。各窓n≥5で有効 */
  function windowTrend(entries, dateStr, metric) {
    const end = dateToNum(dateStr) + 1; // 当日含む
    const collect = (from, to) => entries
      .filter(e => { const d = dateToNum(e.date); return d >= from && d < to; })
      .map(e => e[metric]).filter(v => typeof v === 'number');
    const recent = collect(end - 28, end);
    const prior = collect(end - 56, end - 28);
    if (recent.length < 5 || prior.length < 5) return null;
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    return { diff: mean(recent) - mean(prior), recentMean: mean(recent), priorMean: mean(prior), nRecent: recent.length, nPrior: prior.length };
  }

  /* 状態評価コメント（体調・体重・体脂肪率）。ルールベースの決定的生成。
   * opts.goalWeight: 目標体重（端末ローカル設定。未設定なら言及しない） */
  function comments(entries, entry, opts) {
    const goalWeight = opts && typeof opts.goalWeight === 'number' ? opts.goalWeight : null;
    const c = condition(entries, entry);
    const out = {};

    // --- 体調 ---
    {
      const parts = [];
      if (c.state === 'building') {
        parts.push('基準線構築中（有効記録7日未満の指標あり）のため総合評価は保留。');
      } else {
        const names = { hrv: 'HRV', sleep: '睡眠', bb: 'BB' };
        const flagged = ['hrv', 'sleep', 'bb'].filter(m => c.signals[m] === 'yellow' || c.signals[m] === 'red');
        const missing = ['hrv', 'sleep', 'bb'].filter(m => c.signals[m] === null);
        if (flagged.length === 0) {
          parts.push(`回復3指標は基準線圏内${c.avgDev !== null && c.avgDev >= 5 ? `（平均 +${c.avgDev.toFixed(1)}% と上振れ）` : ''}。`);
        } else {
          parts.push(flagged.map(m => `${names[m]}が基準線比 ${c.recovery.deviations[m].toFixed(1)}%（${SIGNAL_LABELS[c.signals[m]]}）`).join('、') + '。');
        }
        if (missing.length) parts.push(`${missing.map(m => names[m]).join('・')}は当日値なし。`);
        if (c.signals.rhr === 'yellow' || c.signals.rhr === 'red') {
          parts.push(`安静時心拍が基準線比 +${c.rhrDev.toFixed(1)}% と高め（交感神経優位の可能性）。`);
        }
        if (c.recovery.relaxed) parts.push('golf交絡により回復度は1段階緩和済み。');
        else if (Array.isArray(entry.confounds) && entry.confounds.length) parts.push(`交絡（${entry.confounds.join(', ')}）あり、数値は割り引いて解釈。`);
      }
      out.condition = parts.join(' ');
    }

    // --- 体重 ---
    {
      let latest = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (typeof entries[i].weight === 'number' && dateToNum(entries[i].date) <= dateToNum(entry.date)) { latest = entries[i]; break; }
      }
      if (!latest) {
        out.weight = '体重の記録なし。';
      } else {
        const b = baseline(entries, entry.date, 'weight');
        const dev = deviationPct(latest.weight, b.mean);
        const parts = [`${latest.weight.toFixed(1)}kg（${latest.date}実測${dev !== null ? `、基準線比 ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%` : ''}）。`];
        const tr = windowTrend(entries, entry.date, 'weight');
        if (tr) {
          const d = tr.diff;
          parts.push(`直近28日平均 ${tr.recentMean.toFixed(1)}kg は前28日比 ${d >= 0 ? '+' : ''}${d.toFixed(1)}kg と${Math.abs(d) < 0.2 ? '横ばい' : d < 0 ? '減少' : '増加'}。`);
        } else {
          parts.push('推移評価には記録不足（各28日窓に5件以上必要）。');
        }
        if (goalWeight !== null) {
          const gap = latest.weight - goalWeight;
          parts.push(gap > 0 ? `目標${goalWeight.toFixed(1)}kgまで残り${gap.toFixed(1)}kg。` : `目標${goalWeight.toFixed(1)}kgを達成。`);
        }
        if (latest.edema) parts.push('※浮腫フラグ日の実測。割り引いて解釈。');
        out.weight = parts.join(' ');
      }
    }

    // --- 体脂肪率 ---
    {
      let latest = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (typeof entries[i].fat === 'number' && dateToNum(entries[i].date) <= dateToNum(entry.date)) { latest = entries[i]; break; }
      }
      if (!latest) {
        out.fat = '体脂肪率の記録なし。';
      } else {
        const b = baseline(entries, entry.date, 'fat');
        const dev = deviationPct(latest.fat, b.mean);
        const parts = [`${latest.fat.toFixed(1)}%（${latest.date}実測${dev !== null ? `、基準線比 ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%` : ''}）。`];
        const tr = windowTrend(entries, entry.date, 'fat');
        if (tr) {
          const d = tr.diff;
          parts.push(`直近28日平均 ${tr.recentMean.toFixed(1)}% は前28日比 ${d >= 0 ? '+' : ''}${d.toFixed(1)}pt と${Math.abs(d) < 0.2 ? '横ばい' : d < 0 ? '低下' : '上昇'}。`);
        } else {
          parts.push('推移評価には記録不足（各28日窓に5件以上必要）。');
        }
        if (latest.edema) parts.push('※浮腫フラグ日の実測。体脂肪率は見かけ上低く出るため割り引いて解釈。');
        out.fat = parts.join(' ');
      }
    }

    return out;
  }

  /* §F5 月次サマリー: 要約＋TSV */
  function monthlySummary(entries, yyyymm) {
    const inMonth = entries.filter(e => e.date.slice(0, 7) === yyyymm)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    const y = +yyyymm.slice(0, 4), m = +yyyymm.slice(5, 7);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const avg = f => {
      const v = inMonth.map(e => e[f]).filter(x => typeof x === 'number');
      return v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length, n: v.length } : { mean: null, n: 0 };
    };
    const fmt = (a, digits) => a.mean !== null ? `平均 ${a.mean.toFixed(digits)}（n=${a.n}）` : '記録なし';
    const confCount = {};
    for (const c of CONFOUNDS) confCount[c] = inMonth.filter(e => e.confounds.includes(c)).length;
    const lines = [];
    lines.push(`【月次サマリー ${yyyymm}】`);
    lines.push(`記録日数: ${inMonth.length}/${daysInMonth}`);
    lines.push(`HRV: ${fmt(avg('hrv'), 1)} ms`);
    lines.push(`安静時心拍: ${fmt(avg('rhr'), 1)} bpm`);
    lines.push(`睡眠スコア: ${fmt(avg('sleep'), 1)}`);
    lines.push(`Body Battery: ${fmt(avg('bb'), 1)}`);
    lines.push(`体重: ${fmt(avg('weight'), 2)} kg`);
    lines.push(`体脂肪率: ${fmt(avg('fat'), 1)} %`);
    lines.push(`骨格筋率: ${fmt(avg('muscle'), 1)} %`);
    lines.push(`気分: ${fmt(avg('mood'), 2)}`);
    lines.push(`交絡: ` + CONFOUNDS.map(c => `${c} ${confCount[c]}日`).join(' / '));
    lines.push(`浮腫検出: ${inMonth.filter(e => e.edema).length}日 / 基準線除外: ${inMonth.filter(e => isExcludedFromBaseline(e)).length}日`);
    lines.push('');
    lines.push('--- TSV（スプレッドシート転記用） ---');
    const cols = ['date', 'hrv', 'rhr', 'sleep', 'bb', 'weight', 'mood', 'fat', 'muscle', 'visceral', 'confounds', 'excludeBaseline', 'edema', 'note'];
    lines.push(cols.join('\t'));
    for (const e of inMonth) {
      lines.push(cols.map(c => {
        const v = e[c];
        if (v === null || v === undefined) return '';
        if (Array.isArray(v)) return v.join(',');
        if (typeof v === 'boolean') return v ? '1' : '';
        return String(v).replace(/\t|\n/g, ' ');
      }).join('\t'));
    }
    return lines.join('\n');
  }

  return {
    NUMERIC_FIELDS, CONFOUNDS, BASELINE_DAYS, MIN_N, FAILURE_MODES,
    CONDITION_LABELS, SIGNAL_LABELS,
    dateToNum, isValidDateStr, isExcludedFromBaseline,
    baseline, deviationPct, recovery, moodTrack, detectEdema,
    signal, condition, windowTrend, comments,
    parseImport, exportJSON, statusHeaderText, monthlySummary
  };
});
