/* RF基準線トラッカー コアロジック（要件定義書 v1.0 §4 準拠・現行v1.2移植。v1.4.0で減量モニタリング層を追加）
 * 純関数のみ。ブラウザ(window.RFLogic)とNode(module.exports)の両方で動く。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RFLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // v1.4.0: steps/kcalOut/kcalActive（Garmin活動量）・kcalIn/protein（手入力）を後方互換で追加。
  // 旧JSON（キーなし）はnull扱いで受理、旧アプリは未知キーを無視するため双方向に安全
  // v1.6.0: stress（Garmin日中平均ストレス 0-100・低いほど良い）・stressHighMin（高ストレス時間 分）を追加
  const NUMERIC_FIELDS = ['hrv', 'rhr', 'sleep', 'bb', 'weight', 'mood', 'fat', 'muscle', 'visceral',
    'steps', 'kcalOut', 'kcalActive', 'kcalIn', 'protein', 'stress', 'stressHighMin',
    'bedHour', 'sleepHrs']; // v1.6.1: 就寝時刻（24h表記の小数時・0:30就寝=24.5）・睡眠時間（h）
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
   * existingEntries: DB内の既存エントリ（浮腫検出の前日参照とマージ元に使用）。
   * opts.merge: trueなら既存エントリと項目単位でマージ（2026-08-10改訂・取込タブの既定）。
   *   数値フィールドは非nullのみ上書き、confounds/noteは空なら既存保持、
   *   excludeBaseline/edemaはOR。フィールドの消去はマージでは不可＝記録タブ（置換）で行う。
   * 返り値: { entries: 正規化済みエントリ[], errors: [{index, date, reason}], edemaDetected: [date] } */
  function parseImport(jsonText, existingEntries, opts) {
    const merge = !!(opts && opts.merge);
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

    // 日付昇順に処理（浮腫自動検出が前日値に依存）。マージは浮腫検出より前に適用
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const map = new Map((existingEntries || []).map(e => [e.date, e]));
    const edemaDetected = [];
    for (const e of rows) {
      if (merge && map.has(e.date)) {
        const old = map.get(e.date);
        for (const f of NUMERIC_FIELDS) { if (e[f] === null) e[f] = old[f] ?? null; }
        if (e.confounds.length === 0) e.confounds = old.confounds || [];
        e.excludeBaseline = e.excludeBaseline || old.excludeBaseline === true;
        e.edema = e.edema || old.edema === true;
        if (e.note === '') e.note = typeof old.note === 'string' ? old.note : '';
      }
      const prior = [...map.values()];
      if (!e.edema && detectEdema(prior, e)) {
        e.edema = true;
        edemaDetected.push(e.date);
      }
      map.set(e.date, e);
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
      visceral: e.visceral,
      steps: e.steps ?? null, kcalOut: e.kcalOut ?? null, kcalActive: e.kcalActive ?? null,
      kcalIn: e.kcalIn ?? null, protein: e.protein ?? null,
      stress: e.stress ?? null, stressHighMin: e.stressHighMin ?? null,
      bedHour: e.bedHour ?? null, sleepHrs: e.sleepHrs ?? null,
      confounds: e.confounds,
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
    lines.push(`歩数: ${fmt(avg('steps'), 0)}`);
    lines.push(`消費kcal(Garmin推定): ${fmt(avg('kcalOut'), 0)} / 活動kcal: ${fmt(avg('kcalActive'), 0)}`);
    lines.push(`摂取kcal: ${fmt(avg('kcalIn'), 0)} / タンパク質: ${fmt(avg('protein'), 0)} g`);
    lines.push(`ストレス平均: ${fmt(avg('stress'), 0)} / 高ストレス: ${fmt(avg('stressHighMin'), 0)} 分/日`);
    lines.push(`就寝時刻: ${fmt(avg('bedHour'), 2)} 時 / 睡眠時間: ${fmt(avg('sleepHrs'), 2)} h`);
    lines.push(`交絡: ` + CONFOUNDS.map(c => `${c} ${confCount[c]}日`).join(' / '));
    lines.push(`浮腫検出: ${inMonth.filter(e => e.edema).length}日 / 基準線除外: ${inMonth.filter(e => isExcludedFromBaseline(e)).length}日`);
    lines.push('');
    lines.push('--- TSV（スプレッドシート転記用） ---');
    const cols = ['date', 'hrv', 'rhr', 'sleep', 'bb', 'weight', 'mood', 'fat', 'muscle', 'visceral',
      'steps', 'kcalOut', 'kcalActive', 'kcalIn', 'protein', 'stress', 'stressHighMin', 'bedHour', 'sleepHrs', 'confounds', 'excludeBaseline', 'edema', 'note'];
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


  /* ===== v1.4.0 減量モニタリング（表示レイヤー追加・コアロジック§4は不変更） =====
   * 判定軸は「減量ペース」と「体組成の質」。補助として収支（Garmin推定）・タンパク質・活動量。
   * すべての軸に insufficient（判定保留）を持たせ、データ不足時に推測しない。 */
  const WL_DEFAULTS = { deficitTarget: 500, proteinTarget: 150, bmr: null };  // bmr: 基礎代謝（体組成計の値）。null=Garmin推定消費を使う
  const WL_THRESHOLDS = {
    paceFast: -0.5,      // kg/週。≈月2kg超（基準線ドキュメント「月2kg超の急減禁止」）
    paceGood: -0.15,     // kg/週。これより緩いと停滞
    monthlyFast: -2.0,   // 28日平均 vs 前28日平均の差（kg）
    compDelta: 0.3,      // 脂肪量・除脂肪量の28日平均差の判定幅（kg）
    deficitLow: 0.7, deficitHigh: 1.4, // 目標赤字に対する許容比
    proteinOk: 0.9,      // 目標タンパク質に対する許容比
    activityDev: 10,     // 歩数7日平均の基準線比（%）
    paceMinN: 6, paceMinSpan: 14, compMinN: 4, energyMinN: 3, stepsMinN: 4
  };
  const WL_LABELS = {
    pace: { fast: '急減', good: '適正', stall: '停滞', gain: '増加', insufficient: '判定保留' },
    composition: { good: '良質', lean_loss: '除脂肪減', flat: '横ばい', fat_gain: '脂肪増', insufficient: '判定保留' },
    energy: { on: '目標圏内', below: '赤字不足', above: '赤字過大', insufficient: '判定保留' },
    protein: { ok: '充足', low: '不足', insufficient: '判定保留' },
    activity: { up: '増加', flat: '横ばい', down: '低下', insufficient: '判定保留' }
  };

  /* 当日を含む直近days日の値配列。pickは指標名または fn(entry)->number|null。
   * opts.excludeFlagged=true で edema / excludeBaseline / sick の日を除外 */
  function windowValues(entries, dateStr, days, pick, opts) {
    const end = dateToNum(dateStr) + 1; // exclusive（当日含む）
    const start = end - days;
    const excl = !!(opts && opts.excludeFlagged);
    const f = typeof pick === 'function' ? pick : e => e[pick];
    const out = [];
    for (const e of entries) {
      const d = dateToNum(e.date);
      if (d < start || d >= end) continue;
      if (excl && (e.edema === true || isExcludedFromBaseline(e))) continue;
      const v = f(e);
      if (typeof v === 'number' && isFinite(v)) out.push({ date: e.date, x: d - start, v });
    }
    return out;
  }

  /* 最小二乗勾配（単位: v/日）×7 = v/週。点が2未満または x が全同一なら null */
  function slopePerWeek(points) {
    const n = points.length;
    if (n < 2) return null;
    const mx = points.reduce((a, p) => a + p.x, 0) / n;
    const my = points.reduce((a, p) => a + p.v, 0) / n;
    let sxx = 0, sxy = 0;
    for (const p of points) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.v - my); }
    if (sxx === 0) return null;
    return sxy / sxx * 7;
  }

  const meanOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const fatMassOf = e => (typeof e.weight === 'number' && typeof e.fat === 'number') ? e.weight * e.fat / 100 : null;
  const leanMassOf = e => (typeof e.weight === 'number' && typeof e.fat === 'number') ? e.weight * (100 - e.fat) / 100 : null;
  const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(2);

  /* 28日平均 vs 前28日平均（派生値対応版。除外日・浮腫日を除く） */
  function derivedWindowTrend(entries, dateStr, fn, minN) {
    const recent = windowValues(entries, dateStr, 28, fn, { excludeFlagged: true }).map(p => p.v);
    const end = dateToNum(dateStr) + 1;
    const prior = [];
    for (const e of entries) {
      const d = dateToNum(e.date);
      if (d < end - 56 || d >= end - 28) continue;
      if (e.edema === true || isExcludedFromBaseline(e)) continue;
      const v = fn(e);
      if (typeof v === 'number' && isFinite(v)) prior.push(v);
    }
    const r = { recent: meanOf(recent), prior: meanOf(prior), diff: null, nRecent: recent.length, nPrior: prior.length };
    if (recent.length >= minN && prior.length >= minN) r.diff = r.recent - r.prior;
    return r;
  }

  /* 消費kcalの算定（v1.6.2）。bmr（基礎代謝・体組成計の値）が設定されていれば 基礎代謝＋Garmin活動kcal、
   * 未設定なら Garmin推定の総消費（kcalOut）。Garminの基礎代謝は体組成計より約300kcal高く出るため
   * （2026-09-09 RF指摘: Garmin 2,226 vs オムロン 1,900）、設定時はGarminの総消費を使わない */
  function energyOut(e, bmr) {
    if (typeof bmr === 'number') return typeof e.kcalActive === 'number' ? bmr + e.kcalActive : null;
    return typeof e.kcalOut === 'number' ? e.kcalOut : null;
  }

  /* 減量モニタリング判定。opts: { goalWeight, deficitTarget, proteinTarget, bmr }（未設定はWL_DEFAULTS） */
  function weightLossStatus(entries, dateStr, opts) {
    const T = WL_THRESHOLDS;
    const goalWeight = opts && typeof opts.goalWeight === 'number' ? opts.goalWeight : null;
    const deficitTarget = opts && typeof opts.deficitTarget === 'number' ? opts.deficitTarget : WL_DEFAULTS.deficitTarget;
    const proteinTarget = opts && typeof opts.proteinTarget === 'number' ? opts.proteinTarget : WL_DEFAULTS.proteinTarget;
    const bmr = opts && typeof opts.bmr === 'number' && opts.bmr > 0 ? opts.bmr : null;
    const today = dateToNum(dateStr);

    // 最新実測体重（当日以前）
    let latest = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (typeof e.weight === 'number' && dateToNum(e.date) <= today) { latest = { weight: e.weight, date: e.date, edema: e.edema === true }; break; }
    }
    const remaining = latest && goalWeight !== null ? latest.weight - goalWeight : null;

    // --- ペース: 28日窓のOLS勾配（kg/週）。疎データでも単発の水分変動に引きずられにくい ---
    const pace = { state: 'insufficient', slopeKgWeek: null, n: 0, spanDays: 0, monthly: null, monthlyFast: false, reason: '' };
    {
      const pts = windowValues(entries, dateStr, 28, 'weight', { excludeFlagged: true });
      pace.n = pts.length;
      pace.spanDays = pts.length ? pts[pts.length - 1].x - pts[0].x : 0;
      pace.monthly = windowTrend(entries, dateStr, 'weight');
      if (pace.monthly && pace.monthly.diff <= T.monthlyFast) pace.monthlyFast = true;
      if (pts.length >= T.paceMinN && pace.spanDays >= T.paceMinSpan) {
        const s = slopePerWeek(pts);
        pace.slopeKgWeek = s;
        if (s !== null) {
          if (s <= T.paceFast) pace.state = 'fast';
          else if (s <= T.paceGood) pace.state = 'good';
          else if (s < -T.paceGood) pace.state = 'stall';
          else pace.state = 'gain';
        }
      }
      if (pace.monthlyFast && pace.state !== 'insufficient') pace.state = 'fast';
      if (pace.state === 'insufficient') {
        pace.reason = `直近28日の有効体重が${pace.n}件（期間${pace.spanDays}日）。判定には6件以上・14日以上が必要。`;
        if (pace.monthlyFast) pace.reason += ` 28日平均は前28日比 ${pace.monthly.diff.toFixed(1)}kg と月2kgルール超過。`;
      } else {
        const s = pace.slopeKgWeek;
        pace.reason = `28日窓の傾き ${sgn(s)}kg/週（n=${pace.n}）。`;
        if (pace.state === 'fast') pace.reason += pace.monthlyFast ? `28日平均が前28日比 ${pace.monthly.diff.toFixed(1)}kg で月2kg超の急減。ペースを緩める。` : '月2kg超に相当する急減。ペースを緩める。';
        else if (pace.state === 'good') pace.reason += '月0.6〜2kgの範囲で適正。';
        else if (pace.state === 'stall') pace.reason += '停滞圏。収支と活動量を確認。';
        else pace.reason += '増加傾向。';
      }
    }

    // --- 体組成の質: 脂肪量・除脂肪量の28日平均 vs 前28日平均 ---
    const composition = { state: 'insufficient', fatMass: null, leanMass: null, reason: '' };
    {
      const fm = derivedWindowTrend(entries, dateStr, fatMassOf, T.compMinN);
      const lm = derivedWindowTrend(entries, dateStr, leanMassOf, T.compMinN);
      composition.fatMass = fm; composition.leanMass = lm;
      if (fm.diff !== null && lm.diff !== null) {
        if (fm.diff <= -T.compDelta && lm.diff >= -T.compDelta) composition.state = 'good';
        else if (fm.diff <= -T.compDelta && lm.diff < -T.compDelta) composition.state = 'lean_loss';
        else if (fm.diff >= T.compDelta) composition.state = 'fat_gain';
        else composition.state = 'flat';
        composition.reason = `脂肪量 ${sgn(fm.diff)}kg・除脂肪量 ${sgn(lm.diff)}kg（直近28日平均 vs 前28日、n=${fm.nRecent}/${fm.nPrior}）。`;
        if (composition.state === 'good') composition.reason += '脂肪が減り除脂肪量は維持。';
        else if (composition.state === 'lean_loss') composition.reason += '除脂肪量が落ちている。タンパク質と筋トレ量を確認。';
        else if (composition.state === 'fat_gain') composition.reason += '脂肪量が増加。';
        else composition.reason += '有意な変化なし。';
      } else {
        composition.reason = `体重・体脂肪率が揃う日が直近28日 ${fm.nRecent}件／前28日 ${fm.nPrior}件。各窓4件以上が必要。`;
      }
    }

    // --- 収支（消費 − 摂取。直近7日で両方ある日。消費の算定は energyOut 参照） ---
    const basisLabel = bmr !== null ? `基礎代謝${bmr}＋Garmin活動kcal` : 'Garmin推定';
    const energy = { state: 'insufficient', kcalIn: null, kcalOut: null, deficit: null, n: 0, expectedKgWeek: null, target: deficitTarget,
      basis: bmr !== null ? 'bmr' : 'garmin', bmr, basisLabel, outN: 0, intakeTarget: null,
      protein: { state: 'insufficient', mean: null, n: 0, target: proteinTarget }, reason: '' };
    {
      const both = windowValues(entries, dateStr, 7, e => { const o = energyOut(e, bmr); return (typeof e.kcalIn === 'number' && o !== null) ? o - e.kcalIn : null; });
      energy.n = both.length;
      const ins = windowValues(entries, dateStr, 7, 'kcalIn').map(p => p.v);
      const outs = windowValues(entries, dateStr, 7, e => energyOut(e, bmr)).map(p => p.v);
      energy.kcalIn = meanOf(ins); energy.kcalOut = meanOf(outs); energy.outN = outs.length;
      // 目安摂取 = 直近7日の平均消費 − 目標赤字（消費がn≥3あれば摂取記録がなくても出す）
      if (outs.length >= T.energyMinN) energy.intakeTarget = energy.kcalOut - deficitTarget;
      if (both.length >= T.energyMinN) {
        energy.deficit = meanOf(both.map(p => p.v));
        energy.expectedKgWeek = -energy.deficit * 7 / 7700;
        if (energy.deficit < T.deficitLow * deficitTarget) energy.state = 'below';
        else if (energy.deficit > T.deficitHigh * deficitTarget) energy.state = 'above';
        else energy.state = 'on';
        energy.reason = `7日平均 赤字 ${Math.round(energy.deficit)}kcal/日（目標${deficitTarget}・n=${both.length}・消費は${basisLabel}）。理論ペース ${sgn(energy.expectedKgWeek)}kg/週。`;
      } else {
        energy.reason = `摂取と消費が揃う日が直近7日で${both.length}件。3件以上が必要。`;
      }
      if (energy.intakeTarget !== null) energy.reason += ` 目安摂取 ${Math.round(energy.intakeTarget)}kcal/日（平均消費${Math.round(energy.kcalOut)}−目標赤字${deficitTarget}）。`;
      const pr = windowValues(entries, dateStr, 7, 'protein').map(p => p.v);
      energy.protein.n = pr.length; energy.protein.mean = meanOf(pr);
      if (pr.length >= T.energyMinN) {
        energy.protein.state = energy.protein.mean >= T.proteinOk * proteinTarget ? 'ok' : 'low';
      }
    }

    // --- 活動量: 歩数7日平均 vs 28日基準線 ---
    const activity = { state: 'insufficient', steps7: null, stepsBase: null, stepsDev: null, kcalActive7: null, reason: '' };
    {
      const st = windowValues(entries, dateStr, 7, 'steps').map(p => p.v);
      activity.steps7 = meanOf(st);
      activity.kcalActive7 = meanOf(windowValues(entries, dateStr, 7, 'kcalActive').map(p => p.v));
      activity.stepsBase = baseline(entries, dateStr, 'steps');
      if (st.length >= T.stepsMinN && activity.stepsBase.n >= MIN_N) {
        activity.stepsDev = deviationPct(activity.steps7, activity.stepsBase.mean);
        if (activity.stepsDev === null) activity.state = 'insufficient';
        else if (activity.stepsDev >= T.activityDev) activity.state = 'up';
        else if (activity.stepsDev <= -T.activityDev) activity.state = 'down';
        else activity.state = 'flat';
        activity.reason = `歩数7日平均 ${Math.round(activity.steps7)}歩（基準線 ${Math.round(activity.stepsBase.mean)}歩比 ${activity.stepsDev >= 0 ? '+' : ''}${activity.stepsDev.toFixed(1)}%）。`;
      } else {
        activity.reason = `歩数が直近7日 ${st.length}件／基準線 n=${activity.stepsBase.n}。7日4件以上・基準線7件以上が必要。`;
      }
    }

    return { date: dateStr, goalWeight, latest, remaining, pace, composition, energy, activity };
  }

  /* 減量モニターの全文テキスト（コピー用・statusHeaderTextと同形式） */
  function weightLossText(entries, dateStr, opts) {
    const w = weightLossStatus(entries, dateStr, opts);
    const lines = [];
    lines.push(`【減量モニター ${dateStr}】`);
    if (w.latest) {
      let l = `体重: ${w.latest.weight.toFixed(1)}kg（${w.latest.date}実測${w.latest.edema ? '・浮腫' : ''}）`;
      if (w.goalWeight !== null) l += w.remaining > 0 ? ` 目標${w.goalWeight.toFixed(1)}kgまで残り${w.remaining.toFixed(1)}kg` : ` 目標${w.goalWeight.toFixed(1)}kg達成`;
      lines.push(l);
    } else {
      lines.push('体重: 記録なし');
    }
    lines.push(`減量ペース: ${WL_LABELS.pace[w.pace.state]} — ${w.pace.reason}`);
    lines.push(`体組成の質: ${WL_LABELS.composition[w.composition.state]} — ${w.composition.reason}`);
    lines.push(`収支: ${WL_LABELS.energy[w.energy.state]} — ${w.energy.reason}`);
    const p = w.energy.protein;
    lines.push(`タンパク質: ${WL_LABELS.protein[p.state]}${p.mean !== null ? ` — 7日平均 ${Math.round(p.mean)}g（目標${p.target}g・n=${p.n}）` : ''}`);
    lines.push(`活動量: ${WL_LABELS.activity[w.activity.state]} — ${w.activity.reason}`);
    return lines.join('\n');
  }

  /* チャート用の移動平均系列。直近weeks週で、各日について当日を含む直近maDays日の平均
   * （浮腫・除外日は算入しない）。値がある日のみ返す。x は期間先頭からの日数 */
  function movingAverageSeries(entries, dateStr, metric, weeks, maDays) {
    const ma = maDays || 7;
    const end = dateToNum(dateStr);
    const start = end - weeks * 7 + 1;
    const byDay = new Map();
    for (const e of entries) {
      if (e.edema === true || isExcludedFromBaseline(e)) continue;
      const v = e[metric];
      if (typeof v === 'number' && isFinite(v)) byDay.set(dateToNum(e.date), v);
    }
    const out = [];
    for (let d = start; d <= end; d++) {
      const vals = [];
      for (let k = d - ma + 1; k <= d; k++) if (byDay.has(k)) vals.push(byDay.get(k));
      if (vals.length) out.push({ x: d - start, y: meanOf(vals), n: vals.length });
    }
    return out;
  }

  return {
    NUMERIC_FIELDS, CONFOUNDS, BASELINE_DAYS, MIN_N, FAILURE_MODES,
    WL_DEFAULTS, WL_THRESHOLDS, WL_LABELS,
    windowValues, slopePerWeek, energyOut, weightLossStatus, weightLossText, movingAverageSeries,
    CONDITION_LABELS, SIGNAL_LABELS,
    dateToNum, isValidDateStr, isExcludedFromBaseline,
    baseline, deviationPct, recovery, moodTrack, detectEdema,
    signal, condition, windowTrend, comments,
    parseImport, exportJSON, statusHeaderText, monthlySummary
  };
});
