/**
 * Parity with TradingView: read a chart export ("Export chart data", CSV) and
 * compare its plotted columns with what a converted script computes on the
 * export's own bars. Running on the export's OHLC, not on another data feed,
 * makes the comparison about the conversion alone.
 *
 * An export starts where the chart's loaded bars start, while TradingView ran
 * the script on earlier history too, so long averages may need some bars to
 * settle: a column that differs at first and then matches to the end is
 * reported as matching from that bar ("warm-up").
 */

export interface TvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface Column {
  title: string;
  values: (number | null)[];
}

export interface TvExport {
  bars: TvBar[];
  /** Median spacing of the bars, ms. */
  periodMs: number;
  /** Plotted columns: everything but time, OHLC and the Volume indicator. */
  columns: Column[];
  hasVolume: boolean;
  /** The price step the export's prices are written in (syminfo.mintick for the run): 0.01 for two decimals. */
  tick: number;
}

export class ParityError extends Error {}

/** CSV cells, minding quotes ("a, b" stays one cell). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const parseTime = (raw: string): number => {
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // Seconds (TradingView's default) or already milliseconds.
    return n < 1e11 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ParityError(`"${s}" isn't a time this reads`);
  return t;
};

export function parseTvCsv(text: string): TvExport {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new ParityError("The file has no rows");
  const header = cells(lines[0]!).map((h) => h.trim());
  const at = (name: string) => header.findIndex((h) => h.toLowerCase() === name);
  const iTime = at("time");
  const [iO, iH, iL, iC] = ["open", "high", "low", "close"].map(at);
  if (iTime < 0 || iO! < 0 || iH! < 0 || iL! < 0 || iC! < 0) throw new ParityError("This isn't a TradingView chart export: it needs time, open, high, low and close columns");
  const iV = header.findIndex((h) => h === "Volume");
  const skip = new Set([iTime, iO, iH, iL, iC, iV]);
  const num = (v: string | undefined) => {
    if (v === undefined || v.trim() === "" || v.trim() === "NaN") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const rows = lines.slice(1).map(cells);
  const bars: TvBar[] = rows.map((r) => ({ time: parseTime(r[iTime] ?? ""), open: num(r[iO!]) ?? NaN, high: num(r[iH!]) ?? NaN, low: num(r[iL!]) ?? NaN, close: num(r[iC!]) ?? NaN, volume: iV >= 0 ? num(r[iV]) : null }));
  const gaps = bars.slice(1).map((b, k) => b.time - bars[k]!.time).sort((a, b) => a - b);
  const periodMs = gaps[gaps.length >> 1] ?? 60_000;
  const columns = header.flatMap((title, k) => (skip.has(k) ? [] : [{ title, values: rows.map((r) => num(r[k])) }]));
  // The most decimals any price is written with gives the market's price step.
  let decimals = 0;
  for (const r of rows.slice(0, 2000)) for (const k of [iO!, iH!, iL!, iC!]) decimals = Math.max(decimals, /\.(\d+)$/.exec((r[k] ?? "").trim())?.[1]?.length ?? 0);
  const tick = Number((10 ** -Math.min(decimals, 10)).toFixed(Math.min(decimals, 10)));
  return { bars, periodMs, columns, hasVolume: iV >= 0, tick };
}

// ---------------- comparison ----------------

/**
 * match: every bar agrees. warmup: agrees from `from` to the end.
 * converging: off on nearly every bar of the second half, by little and less
 * and less toward the end: the script's averages haven't settled on the
 * export's history yet. A few bars that differ among exact ones aren't
 * converging, even when the last bars are exact.
 * differs: disagrees. missing: the export has no such column.
 */
export type ColumnStatus = "match" | "warmup" | "converging" | "differs" | "missing";

export interface ColumnReport {
  title: string;
  status: ColumnStatus;
  /** Bars compared, and how many agree. */
  compared: number;
  equal: number;
  /** Index of the first bar from which every bar agrees (null: never). */
  from: number | null;
  /**
   * Largest relative difference where both have a value (0 when exact): from `from` on
   * for a column that matches to the end (match, warmup), over every compared bar otherwise.
   */
  maxDiff: number;
  /** Relative difference on the last bar where both have a value (0 when equal). */
  lastDiff: number;
  /** The first bar where the two disagree (null: none). */
  example: { index: number; tv: number | null; ours: number | null } | null;
}

export interface ParityReport {
  verdict: "match" | "partial" | "differs";
  bars: number;
  columns: ColumnReport[];
  /** Export columns with no counterpart in the script (another indicator on the chart, say). */
  ignored: string[];
}

/** Relative tolerance: TradingView exports about 15 significant digits. */
export const TOLERANCE = 1e-6;
/** A matching run must reach the end and be at least this long to count. */
const MIN_RUN = 20;

const same = (a: number | null, b: number | null, tol: number) =>
  a === null || b === null ? a === b : Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

export function compareParity(tv: Column[], ours: Column[], tol = TOLERANCE): ParityReport {
  // TradingView repeats a title for plots that share it; ours numbers them ("Plot", "Plot 2").
  const seen = new Map<string, number>();
  const byTitle = new Map(ours.map((c) => [c.title, c]));
  const used = new Set<string>();
  const ignored: string[] = [];
  const columns: ColumnReport[] = [];
  for (const col of tv) {
    const k = (seen.get(col.title) ?? 0) + 1;
    seen.set(col.title, k);
    const mine = byTitle.get(k === 1 ? col.title : `${col.title} ${k}`);
    if (!mine) {
      ignored.push(col.title);
      continue;
    }
    used.add(mine.title);
    const n = Math.min(col.values.length, mine.values.length);
    let equal = 0;
    let from: number | null = null;
    for (let i = n - 1; i >= 0; i--) {
      if (!same(col.values[i]!, mine.values[i] ?? null, tol)) break;
      from = i;
    }
    let firstBad: number | null = null;
    for (let i = 0; i < n; i++) {
      if (same(col.values[i]!, mine.values[i] ?? null, tol)) equal++;
      else firstBad ??= i;
    }
    const rel = (i: number) => {
      const a = col.values[i]!;
      const b = mine.values[i] ?? null;
      return a === null || b === null ? null : Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
    };
    const diffs = Array.from({ length: n }, (_, i) => rel(i));
    const lastDiff = [...diffs].reverse().find((d) => d !== null) ?? 0;
    const half = Math.floor(n / 2);
    const q3 = Math.floor(n * 0.75);
    const maxOf = (lo: number, hi: number) => {
      const ds = diffs.slice(lo, hi).filter((d): d is number => d !== null);
      return ds.length ? Math.max(...ds) : null;
    };
    // Converging: the gap shrinks toward the end. Over the last quarter it stays small, and at most half the
    // largest gap between halfway and three quarters of the way in.
    const earlier = maxOf(half, q3);
    const tail = maxOf(q3, n) ?? 0;
    const shrinking = earlier !== null && earlier > 0 && tail < 1e-3 && tail <= earlier / 2;
    // And it is a gap that persists, as an average's does while it settles: in the second half, nearly every bar
    // where both have a value differs, up to the last one that does. Isolated bars that differ, with exact bars
    // between them, are a difference, not a settling average, even when the last bars happen to be exact.
    let lastBad = -1;
    for (let i = n - 1; i >= half; i--)
      if (!same(col.values[i]!, mine.values[i] ?? null, tol)) {
        lastBad = i;
        break;
      }
    let valued = 0;
    let off = 0;
    for (let i = half; i <= lastBad; i++) {
      if (diffs[i] === null) continue;
      valued++;
      if (!same(col.values[i]!, mine.values[i] ?? null, tol)) off++;
    }
    const persistent = lastBad >= 0 && off >= valued * 0.9;
    // Gaps agree over the second half (the first may still be warming up).
    const nullsAgree = Array.from({ length: n - half }, (_, k) => (col.values[half + k] === null) === ((mine.values[half + k] ?? null) === null)).filter(Boolean).length >= (n - half) * 0.98;
    // Sparse columns (a label now and then): every disagreement a hair's breadth, where both have a value.
    const tinyOnly = Array.from({ length: n - half }, (_, k) => half + k).every((i) => {
      const d = rel(i);
      return same(col.values[i]!, mine.values[i] ?? null, tol) || (d !== null && d < 1e-4);
    });
    const converging = nullsAgree && ((shrinking && persistent) || (tinyOnly && equal >= n * 0.9));
    const status: ColumnStatus =
      from === 0 ? "match" : from !== null && n - from >= Math.min(MIN_RUN, n) && from <= n * 0.8 ? "warmup" : converging ? "converging" : "differs";
    let maxDiff = 0;
    for (let i = status === "match" || status === "warmup" ? from! : 0; i < n; i++) maxDiff = Math.max(maxDiff, diffs[i] ?? 0);
    const ex = firstBad === null ? null : { index: firstBad, tv: col.values[firstBad] ?? null, ours: mine.values[firstBad] ?? null };
    columns.push({ title: col.title, status, compared: n, equal, from, maxDiff, lastDiff, example: ex });
  }
  for (const c of ours) if (!used.has(c.title)) columns.push({ title: c.title, status: "missing", compared: 0, equal: 0, from: null, maxDiff: 0, lastDiff: 0, example: null });
  const checked = columns.filter((c) => c.status !== "missing");
  const good = checked.filter((c) => c.status === "match" || c.status === "warmup" || c.status === "converging").length;
  const verdict = checked.length > 0 && good === checked.length ? "match" : good > 0 ? "partial" : "differs";
  return { verdict, bars: tv[0]?.values.length ?? 0, columns, ignored };
}
