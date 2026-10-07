/**
 * Pine Script's `ta.*` built-ins, evaluated over whole series at once.
 *
 * A series is a plain number[] indexed oldest → newest; NaN stands for Pine's
 * `na`. Every function returns a new series of the same length, and value i
 * uses only bars 0..i, so nothing here can look ahead. Where Pine's handling
 * of `na` or of the first bars matters for parity, the comment says what Pine
 * does and the code copies it.
 */

export type Series = number[];

const isNa = (x: number | undefined): boolean => x === undefined || Number.isNaN(x);

export function nz(x: number, fallback = 0): number {
  return isNa(x) ? fallback : x;
}

export function nzSeries(src: Series, fallback = 0): Series {
  return src.map((x) => nz(x, fallback));
}

/** `src[offset]`: the value `offset` bars back, NaN before the series starts. */
export function at(src: Series, i: number, offset = 0): number {
  const j = i - offset;
  return j < 0 ? NaN : (src[j] ?? NaN);
}

export function change(src: Series, length = 1): Series {
  return src.map((x, i) => x - at(src, i, length));
}

/** Simple moving average. NaN until `length` bars exist, and whenever the window holds a NaN. */
export function sma(src: Series, length: number): Series {
  return src.map((_, i) => {
    if (i < length - 1) return NaN;
    let sum = 0;
    for (let k = i - length + 1; k <= i; k++) sum += src[k]!;
    return sum / length;
  });
}

/**
 * Pine's `math.sum`: the sliding sum of the last `length` values. NaN until
 * `length` bars exist and whenever the window holds a NaN, as `ta.sma` (so
 * `math.sum(math.abs(ta.change(close)), n)` first exists on bar n).
 */
export function sum(src: Series, length: number): Series {
  return src.map((_, i) => {
    if (i < length - 1) return NaN;
    let total = 0;
    for (let k = i - length + 1; k <= i; k++) total += src[k]!;
    return total;
  });
}

/**
 * Pine's `ta.linreg`: the least-squares line through the last `length`
 * values, read `offset` bars back from the newest — `intercept + slope ·
 * (length − 1 − offset)` with x = 0 on the oldest bar of the window. NaN until
 * `length` bars exist and whenever the window holds a NaN.
 */
export function linreg(src: Series, length: number, offset = 0): Series {
  const n = length;
  const sumX = (n * (n - 1)) / 2;
  const sumXX = ((n - 1) * n * (2 * n - 1)) / 6;
  const den = n * sumXX - sumX * sumX;
  return src.map((_, i) => {
    if (i < n - 1) return NaN;
    let sumY = 0;
    let sumXY = 0;
    for (let k = 0; k < n; k++) {
      const y = src[i - n + 1 + k]!;
      if (isNa(y)) return NaN;
      sumY += y;
      sumXY += k * y;
    }
    if (n === 1) return sumY;
    const slope = (n * sumXY - sumX * sumY) / den;
    const intercept = (sumY - slope * sumX) / n;
    return intercept + slope * (n - 1 - offset);
  });
}

/** Linearly weighted moving average: the newest bar weighs `length`, the oldest 1. */
export function wma(src: Series, length: number): Series {
  const norm = (length * (length + 1)) / 2;
  return src.map((_, i) => {
    if (i < length - 1) return NaN;
    let sum = 0;
    for (let k = 0; k < length; k++) sum += src[i - k]! * (length - k);
    return sum / norm;
  });
}

/**
 * Exponentially weighted average with Pine's seeding: the first value is the
 * SMA of the first `length` non-NaN inputs, then `alpha·x + (1 − alpha)·prev`.
 * A NaN input yields NaN and restarts the seed, as `na(sum[1])` does in Pine.
 */
function smoothed(src: Series, length: number, alpha: number): Series {
  const out: Series = new Array(src.length).fill(NaN);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    if (isNa(x)) {
      prev = NaN;
      seedSum = 0;
      seedCount = 0;
      continue;
    }
    if (isNa(prev)) {
      seedSum += x;
      seedCount += 1;
      if (seedCount === length) {
        prev = seedSum / length;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * x + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export function ema(src: Series, length: number): Series {
  return smoothed(src, length, 2 / (length + 1));
}

/** Wilder's moving average (RMA), as used by RSI and ATR. */
export function rma(src: Series, length: number): Series {
  return smoothed(src, length, 1 / length);
}

/**
 * Standard deviation over `length` bars. Pine's default is the population
 * (biased) form; `biased = false` divides by length − 1.
 */
export function stdev(src: Series, length: number, biased = true): Series {
  const mean = sma(src, length);
  return src.map((_, i) => {
    const m = mean[i]!;
    if (isNa(m)) return NaN;
    let ss = 0;
    for (let k = i - length + 1; k <= i; k++) ss += (src[k]! - m) ** 2;
    return Math.sqrt(ss / (biased ? length : length - 1));
  });
}

function windowed(src: Series, length: number, pick: (values: number[]) => number): Series {
  return src.map((_, i) => {
    if (i < length - 1) return NaN;
    const values = src.slice(i - length + 1, i + 1);
    return values.some(isNa) ? NaN : pick(values);
  });
}

/**
 * Pine's ta.highest / ta.lowest skip na inside the window: na until `length`
 * bars exist, then the extreme of the values that are there (na only when the
 * whole window is na), as TradingView does when a window starts while the
 * series feeding it is still warming up.
 */
function extreme(src: Series, length: number, pick: (a: number, b: number) => number): Series {
  return src.map((_, i) => {
    if (i < length - 1) return NaN;
    let out = NaN;
    for (let k = i - length + 1; k <= i; k++) {
      const v = src[k]!;
      if (!isNa(v)) out = isNa(out) ? v : pick(out, v);
    }
    return out;
  });
}

export function highest(src: Series, length: number): Series {
  return extreme(src, length, Math.max);
}

export function lowest(src: Series, length: number): Series {
  return extreme(src, length, Math.min);
}

export function median(src: Series, length: number): Series {
  return windowed(src, length, (v) => {
    const s = [...v].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  });
}

/** Pearson correlation of two series over `length` bars; NaN if either window holds a NaN. */
export function correlation(a: Series, b: Series, length: number): Series {
  return a.map((_, i) => {
    if (i < length - 1) return NaN;
    let sa = 0;
    let sb = 0;
    for (let k = i - length + 1; k <= i; k++) {
      if (isNa(a[k]) || isNa(b[k])) return NaN;
      sa += a[k]!;
      sb += b[k]!;
    }
    const ma = sa / length;
    const mb = sb / length;
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let k = i - length + 1; k <= i; k++) {
      const da = a[k]! - ma;
      const db = b[k]! - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
    }
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
  });
}

/**
 * Nearest-rank percentile of the last `length` values: sort them and take
 * the value at rank ceil(percentage / 100 · length). As on TradingView, the
 * rank counts the whole window and `na`s rank lowest: a window holding k na
 * reads the value at rank − k among the others, and na when rank ≤ k
 * (measured on TradingView's export of a 100-bar BandWidth percentile whose
 * first windows still hold the 19 na bars of a 20-bar Bollinger band).
 * The window is kept sorted as it slides (one insert, one removal per bar)
 * rather than re-sorted on every bar: same values, a fraction of the CPU.
 */
export function percentileNearestRank(src: Series, length: number, percentage: number): Series {
  const out: Series = new Array(src.length).fill(NaN);
  const window: number[] = [];
  const lowerBound = (x: number) => {
    let lo = 0;
    let hi = window.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (window[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    if (!isNa(x)) window.splice(lowerBound(x), 0, x);
    const gone = i >= length ? src[i - length]! : NaN;
    if (!isNa(gone)) window.splice(lowerBound(gone), 1);
    if (i < length - 1 || window.length === 0) continue;
    const rank = Math.min(Math.max(1, Math.ceil((percentage / 100) * length)), length);
    const k = rank - 1 - (length - window.length); // the na values sort first
    if (k >= 0) out[i] = window[k]!;
  }
  return out;
}

/** Percentage of the previous `length` values that are less than or equal to the current one. */
export function percentrank(src: Series, length: number): Series {
  return src.map((x, i) => {
    if (i < length || isNa(x)) return NaN;
    let count = 0;
    for (let k = i - length; k < i; k++) {
      if (isNa(src[k])) return NaN;
      if (src[k]! <= x) count++;
    }
    return (count / length) * 100;
  });
}

/** Running total; NaN inputs count as zero, as `ta.cum(nz(x))` would. */
export function cum(src: Series): Series {
  let total = 0;
  return src.map((x) => (total += nz(x)));
}

/** `a` crosses above `b`: a > b now, a <= b on the previous bar. */
export function crossover(a: Series, b: Series | number): boolean[] {
  const bv = (i: number) => (typeof b === "number" ? b : at(b, i));
  return a.map((x, i) => i > 0 && x > bv(i) && a[i - 1]! <= bv(i - 1));
}

export function crossunder(a: Series, b: Series | number): boolean[] {
  const bv = (i: number) => (typeof b === "number" ? b : at(b, i));
  return a.map((x, i) => i > 0 && x < bv(i) && a[i - 1]! >= bv(i - 1));
}

export function cross(a: Series, b: Series | number): boolean[] {
  const up = crossover(a, b);
  const down = crossunder(a, b);
  return a.map((_, i) => up[i]! || down[i]!);
}

/** Bars since `cond` was last true (0 on the bar itself); NaN before it ever was. */
export function barssince(cond: boolean[]): Series {
  let last = -1;
  return cond.map((c, i) => {
    if (c) last = i;
    return last < 0 ? NaN : i - last;
  });
}

/**
 * Value of `src` on the `occurrence`-th most recent bar where `cond` was
 * true, counting the current bar as occurrence 0.
 */
export function valuewhen(cond: boolean[], src: Series, occurrence: number): Series {
  const hits: number[] = [];
  return cond.map((c, i) => {
    if (c) hits.push(src[i]!);
    const k = hits.length - 1 - occurrence;
    return k < 0 ? NaN : hits[k]!;
  });
}

/**
 * Pivot high confirmed `right` bars after it: the value at i − right is at
 * least as high as each of the `left` bars before it and higher than each of
 * the `right` bars after it. The result sits on the confirmation bar i,
 * exactly where Pine reports it.
 *
 * Ties, as TradingView resolves them: an equal value on the left does not
 * stop a pivot, an equal value on the right does, so of two equal highs the
 * later one is the pivot. Measured on a TradingView chart export (BTC 4H,
 * about 21,000 bars): 3/3, 5/5 and 25/25 pivots with an equal bar only on the
 * left count (46 cases), those with an equal bar on the right do not (40
 * cases); rejecting both ties, as this function did before, missed some.
 */
export function pivothigh(src: Series, left: number, right: number): Series {
  return pivot(src, left, right, (candidate, other) => other > candidate);
}

/** Pivot low: the mirror of `pivothigh`, with the same ties rule (a low equal on the left still counts). */
export function pivotlow(src: Series, left: number, right: number): Series {
  return pivot(src, left, right, (candidate, other) => other < candidate);
}

/** `beaten` decides the left bars; on the right an equal value also beats the candidate. */
function pivot(src: Series, left: number, right: number, beaten: (candidate: number, other: number) => boolean): Series {
  return src.map((_, i) => {
    const p = i - right;
    if (p - left < 0) return NaN;
    const candidate = src[p]!;
    if (isNa(candidate)) return NaN;
    for (let k = p - left; k <= p + right; k++) {
      if (k === p) continue;
      const other = src[k]!;
      if (isNa(other) || beaten(candidate, other) || (k > p && other === candidate)) return NaN;
    }
    return candidate;
  });
}

/**
 * True range. With `handleNa` (Pine's `ta.tr(true)`, and what ta.atr uses)
 * the first bar, which has no previous close, is high − low; without it
 * (plain `ta.tr`) that bar is NaN.
 */
export function tr(high: Series, low: Series, close: Series, handleNa = true): Series {
  return high.map((h, i) => {
    const pc = at(close, i, 1);
    const hl = h - low[i]!;
    if (isNa(pc)) return handleNa ? hl : NaN;
    return Math.max(hl, Math.abs(h - pc), Math.abs(low[i]! - pc));
  });
}

/** Replace NaN with the last non-NaN value seen. */
export function fixnan(src: Series): Series {
  let last = NaN;
  return src.map((x) => (isNa(x) ? last : (last = x)));
}

/** Directional movement: [+DI, −DI, ADX], as Pine's ta.dmi. */
export function dmi(high: Series, low: Series, close: Series, diLength: number, adxSmoothing: number): [Series, Series, Series] {
  const up = change(high);
  const down = change(low).map((x) => -x);
  const plusDM = up.map((u, i) => (isNa(u) ? NaN : u > down[i]! && u > 0 ? u : 0));
  const minusDM = down.map((d, i) => (isNa(d) ? NaN : d > up[i]! && d > 0 ? d : 0));
  const trur = rma(tr(high, low, close, false), diLength);
  const plus = fixnan(rma(plusDM, diLength).map((x, i) => (100 * x) / trur[i]!));
  const minus = fixnan(rma(minusDM, diLength).map((x, i) => (100 * x) / trur[i]!));
  const adx = rma(
    plus.map((p, i) => {
      const sum = p + minus[i]!;
      return Math.abs(p - minus[i]!) / (sum === 0 ? 1 : sum);
    }),
    adxSmoothing,
  ).map((x) => 100 * x);
  return [plus, minus, adx];
}

export function atr(high: Series, low: Series, close: Series, length: number): Series {
  return rma(tr(high, low, close), length);
}

// ---------------- common oscillators and bands (the SDK's first users want these) ----------------

/** Pine's `ta.rsi`: Wilder averages of gains and losses; 100 with no losses, 0 with no gains. */
export function rsi(src: Series, length: number): Series {
  const ch = change(src);
  const up = rma(ch.map((x) => (isNa(x) ? NaN : Math.max(x, 0))), length);
  const down = rma(ch.map((x) => (isNa(x) ? NaN : Math.max(-x, 0))), length);
  return up.map((u, i) => {
    const d = down[i]!;
    if (isNa(u) || isNa(d)) return NaN;
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  });
}

/** Pine's `ta.macd`: [macd line, signal line, histogram]. */
export function macd(src: Series, fast: number, slow: number, signal: number): [Series, Series, Series] {
  const f = ema(src, fast);
  const s = ema(src, slow);
  const line = f.map((x, i) => x - s[i]!);
  const sig = ema(line, signal);
  return [line, sig, line.map((x, i) => x - sig[i]!)];
}

/** Pine's `ta.bb`: [basis, upper, lower] with the population standard deviation. */
export function bb(src: Series, length: number, mult: number): [Series, Series, Series] {
  const basis = sma(src, length);
  const dev = stdev(src, length);
  return [basis, basis.map((b, i) => b + mult * dev[i]!), basis.map((b, i) => b - mult * dev[i]!)];
}

/** Pine's `ta.stoch`: where `src` sits in the `length`-bar high–low range, 0–100. */
export function stoch(src: Series, high: Series, low: Series, length: number): Series {
  const hh = highest(high, length);
  const ll = lowest(low, length);
  return src.map((x, i) => {
    const range = hh[i]! - ll[i]!;
    return isNa(range) || isNa(x) ? NaN : range === 0 ? NaN : (100 * (x - ll[i]!)) / range;
  });
}

/** Pine's `ta.mom`: the change over `length` bars. */
export const mom = (src: Series, length: number): Series => change(src, length);

/** Pine's `ta.roc`: the percentage change over `length` bars. */
export function roc(src: Series, length: number): Series {
  return src.map((x, i) => {
    const prev = at(src, i, length);
    return 100 * ((x - prev) / prev);
  });
}

/** Pine's `ta.vwma`: the volume-weighted moving average. */
export function vwma(src: Series, volume: Series, length: number): Series {
  const num = sma(src.map((x, i) => x * volume[i]!), length);
  const den = sma(volume, length);
  return num.map((x, i) => x / den[i]!);
}

/** Pine's `ta.dev`: the mean absolute deviation from the `length`-bar average. */
export function dev(src: Series, length: number): Series {
  const mean = sma(src, length);
  return src.map((_, i) => {
    const m = mean[i]!;
    if (isNa(m)) return NaN;
    let total = 0;
    for (let k = i - length + 1; k <= i; k++) total += Math.abs(src[k]! - m);
    return total / length;
  });
}

/** Pine's `ta.cci`: distance from the average in units of 0.015 mean deviations. */
export function cci(src: Series, length: number): Series {
  const mean = sma(src, length);
  const d = dev(src, length);
  return src.map((x, i) => (x - mean[i]!) / (0.015 * d[i]!));
}
