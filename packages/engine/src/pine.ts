import { Broker, type StrategyReport } from "./broker";
import { clamp } from "./math";
import * as vec from "./ta";

/**
 * The Pine-compatible runtime: what a script converted by AlphaResin
 * (packages/resin) calls as it runs bar by bar. Part of the public SDK; it
 * holds nothing of AlphaPine's own indicators.
 *
 * - Series history: `ser()` keeps a variable's value per bar for `x[k]`;
 *   `hist()` does the same for an expression at one place in the script.
 * - `ta.*` keep their state per call site (`st`, one object per place in the
 *   script and per caller), fed one value each time the site runs, as Pine's
 *   do. Window functions reuse the whole-series ones in ./ta on the window.
 * - Outputs: plots, shapes, levels, fills, alert conditions and drawn
 *   labels, lines, boxes and tables become the SDK's output shape (lines,
 *   markers, levels, fills, events, segments, zones, dashboard).
 * - Strategies: strategy.* orders go to the broker emulator (./broker); its
 *   entries become events the Terminal measures, its fills markers, and its
 *   own results the strategy report.
 */

export type { StrategyReport, StrategyTrade } from "./broker";

export interface PineBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PineOptions {
  overlay: boolean;
  periodMs: number;
  /** Bars of higher timeframes for the same market, by Pine timeframe string ("D", "240"…): longer history for request.security. */
  higher?: Record<string, PineBar[]>;
  /** The chart's market ("BTCUSD"), so a script naming it reads the chart's own bars. */
  symbol?: string;
  /** Other markets' bars at the chart's timeframe, by market key (marketKey): request.security on them. */
  markets?: Record<string, PineBar[]>;
  mintick?: number;
  maxLabels?: number;
  maxLines?: number;
  maxBoxes?: number;
}

type St = Record<string, unknown> & { b?: number[] };
type Tone = "bull" | "bear" | "neutral" | "warn" | "info";

export const na = NaN;
export const isNa = (x: unknown): boolean => x === undefined || x === null || (typeof x === "number" && Number.isNaN(x));
/** Pine's truthiness for conditions: na and false are false, so is a zero number. */
export const truthy = (x: unknown): boolean => !isNa(x) && x !== false && x !== 0;
export const nz = <T>(x: T, r: T | number = 0): T | number => (isNa(x) ? r : x);

const last = (s: number[]) => s[s.length - 1] ?? NaN;

// ---------------- colours ----------------

/** TradingView's named colours (public palette values). */
export const COLORS = {
  aqua: "#00bcd4ff", black: "#363a45ff", blue: "#2196f3ff", fuchsia: "#e040fbff", gray: "#787b86ff", green: "#4caf50ff",
  lime: "#00e676ff", maroon: "#880e4fff", navy: "#311b92ff", olive: "#808000ff", orange: "#ff9800ff", purple: "#9c27b0ff",
  red: "#f23645ff", silver: "#b2b5beff", teal: "#089981ff", white: "#ffffffff", yellow: "#ffeb3bff",
} as const;

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
function parseColor(c: unknown): { r: number; g: number; b: number; a: number } | null {
  if (typeof c !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return null;
  const n = (k: number) => parseInt(c.slice(k, k + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: c.length === 9 ? n(7) / 255 : 1 };
}
const rgba = (r: number, g: number, b: number, a: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`;

/** A colour as the chart's tone: by hue, neutral when grey or invisible. */
export function toneOf(c: unknown): Tone | null {
  const p = parseColor(c);
  if (!p || p.a === 0) return null;
  const max = Math.max(p.r, p.g, p.b);
  const min = Math.min(p.r, p.g, p.b);
  if (max - min < 40) return "neutral";
  const d = max - min;
  let h = max === p.r ? ((p.g - p.b) / d) % 6 : max === p.g ? (p.b - p.r) / d + 2 : (p.r - p.g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 20 || h >= 330) return "bear";
  if (h < 70) return "warn";
  if (h < 170) return "bull";
  return "info";
}
const visible = (c: unknown) => isNa(c) || (parseColor(c)?.a ?? 1) > 0;

export const color = {
  ...COLORS,
  new: (c: unknown, transp: number = 0) => {
    const p = parseColor(c);
    return p ? rgba(p.r, p.g, p.b, (100 - clamp(nz(transp, 0) as number, 0, 100)) / 100) : NaN;
  },
  rgb: (r: number, g: number, b: number, transp: number = 0) => rgba(r, g, b, (100 - clamp(nz(transp, 0) as number, 0, 100)) / 100),
  r: (c: unknown) => parseColor(c)?.r ?? NaN,
  g: (c: unknown) => parseColor(c)?.g ?? NaN,
  b: (c: unknown) => parseColor(c)?.b ?? NaN,
  t: (c: unknown) => { const p = parseColor(c); return p ? Math.round((1 - p.a) * 100) : NaN; },
  from_gradient: (v: number, lo: number, hi: number, c1: unknown, c2: unknown) => {
    const a = parseColor(c1);
    const b = parseColor(c2);
    if (!a || !b || isNa(v)) return NaN;
    const k = hi === lo ? 0 : clamp((v - lo) / (hi - lo), 0, 1);
    return rgba(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k, a.a + (b.a - a.a) * k);
  },
};

// ---------------- maths and strings ----------------

const nums = (xs: unknown[]) => xs.flat() as number[];
let randomSeed: number | null = null;
let randomState = 1;
export const math = {
  pi: Math.PI,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  abs: Math.abs,
  sign: Math.sign,
  sqrt: Math.sqrt,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  pow: Math.pow,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  todegrees: (r: number) => (r * 180) / Math.PI,
  /** \`math.random(min, max, seed)\`: with a seed, the same sequence on every run. */
  random: (min = 0, max = 1, seed?: number) => {
    if (seed !== undefined && !Number.isNaN(seed)) {
      if (randomSeed !== seed) [randomSeed, randomState] = [seed, Math.abs(Math.trunc(seed)) % 2147483646 || 1];
      randomState = (randomState * 16807) % 2147483647;
      return min + ((randomState - 1) / 2147483646) * (max - min);
    }
    return min + Math.random() * (max - min);
  },
  toradians: (d: number) => (d * Math.PI) / 180,
  round: (x: number, precision?: number) => {
    if (isNa(x)) return NaN;
    if (precision === undefined || isNa(precision)) return Math.sign(x) * Math.round(Math.abs(x));
    const f = 10 ** precision;
    return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
  },
  max: (...xs: unknown[]) => { const v = nums(xs); return v.some(isNa) ? NaN : Math.max(...v); },
  min: (...xs: unknown[]) => { const v = nums(xs); return v.some(isNa) ? NaN : Math.min(...v); },
  avg: (...xs: unknown[]) => { const v = nums(xs); return v.reduce((s, x) => s + x, 0) / v.length; },
};

function formatNumber(x: number, fmt?: string, mintick = 0.01): string {
  if (isNa(x)) return "NaN";
  if (fmt === "format.mintick") {
    const d = Math.max(0, Math.round(-Math.log10(mintick)));
    return x.toFixed(d);
  }
  if (fmt === "format.percent") return `${(Math.round(x * 100) / 100).toString()}%`;
  if (fmt === "format.volume") {
    const a = Math.abs(x);
    return a >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(x / 1e3).toFixed(2)}K` : x.toFixed(2);
  }
  if (typeof fmt === "string" && /^[#0,]*\.?[#0]*%?$/.test(fmt) && fmt.length > 0) {
    const decimals = fmt.includes(".") ? fmt.split(".")[1]!.replace("%", "").length : 0;
    const pct = fmt.endsWith("%");
    const v = pct ? x * 100 : x;
    const fixed = fmt.includes(".") && fmt.split(".")[1]!.startsWith("0") ? v.toFixed(decimals) : String(Math.round(v * 10 ** decimals) / 10 ** decimals);
    return pct ? `${fixed}%` : fixed;
  }
  return String(Math.round(x * 1e8) / 1e8);
}

// ---------------- timeframes ----------------

/**
 * A Pine timeframe string ("", "1", "60", "240", "D", "1D", "W", "M", "3M",
 * "30S") as a unit and a count; "" (or the chart's own) is the chart's.
 */
export interface Tf {
  unit: "S" | "m" | "D" | "W" | "M";
  k: number;
  /** Approximate length, ms (months as 30 days), for comparing timeframes. */
  ms: number;
}

export function parseTf(tf: unknown): Tf | null {
  const s = String(tf ?? "").trim().toUpperCase();
  if (!s) return null;
  const m = /^(\d*)([SDWMH]?)$/.exec(s);
  if (!m) return null;
  const k = m[1] ? Number(m[1]) : 1;
  if (!(k > 0)) return null;
  switch (m[2]) {
    case "S":
      return { unit: "S", k, ms: k * 1000 };
    case "H":
      return { unit: "m", k: k * 60, ms: k * 3_600_000 };
    case "D":
      return { unit: "D", k, ms: k * 86_400_000 };
    case "W":
      return { unit: "W", k, ms: k * 604_800_000 };
    case "M":
      return { unit: "M", k, ms: k * 2_592_000_000 };
    default:
      return { unit: "m", k, ms: k * 60_000 };
  }
}

/** One spelling per timeframe ("D", "1D" and "1d" alike), for keying higher-timeframe bars. */
export const tfKey = (f: Tf) => `${f.unit}${f.k}`;

/**
 * A market as the Terminal names it, from a TradingView symbol: "BINANCE:ETHUSDT"
 * and "COINBASE:ETHUSD" are both "ETHUSD" (stablecoin quotes read as USD,
 * perpetuals as their spot). Heikin Ashi tickers keep an "HA:" mark.
 */
export function marketKey(symbol: unknown): string {
  let s = String(symbol ?? "").trim().toUpperCase();
  if (!s) return "";
  const ha = s.startsWith("HA:");
  if (ha) s = s.slice(3);
  s = s.replace(/^[A-Z0-9_]+:/, "").replace(/(\.P|PERP)$/, "");
  const m = /^([A-Z0-9]+?)(USDT|USDC|BUSD|FDUSD|USD)$/.exec(s);
  if (m) s = `${m[1]}USD`;
  return ha ? `HA:${s}` : s;
}

/** Heikin Ashi bars from regular ones. */
export function heikinAshi(bars: PineBar[]): PineBar[] {
  const out: PineBar[] = [];
  for (const b of bars) {
    const p = out[out.length - 1];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = p ? (p.open + p.close) / 2 : (b.open + b.close) / 2;
    out.push({ time: b.time, open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close, volume: b.volume });
  }
  return out;
}

/** A timezone's offset from UTC at `t` in ms: "UTC", "GMT+2", "UTC-05:30" or an IANA name ("America/New_York"). */
export function tzOffset(tz: string, t: number): number {
  const z = tz.trim();
  if (/^(utc|gmt|etc\/utc|z)$/i.test(z) || !z) return 0;
  const m = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(z);
  if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(t);
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(t / 1000) * 1000;
  } catch {
    return 0;
  }
}

const WEEK_OFFSET = 4 * 86_400_000; // The epoch was a Thursday: weeks start on Monday 00:00 UTC.

/** Start of the `tf` bar that `t` falls in (UTC; calendar months; weeks from Monday). */
export function floorTf(tf: Tf, t: number): number {
  switch (tf.unit) {
    case "M": {
      const d = new Date(t);
      const m0 = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / tf.k) * tf.k;
      return Date.UTC(Math.floor(m0 / 12), m0 % 12, 1);
    }
    case "W":
      return Math.floor((t - WEEK_OFFSET) / tf.ms) * tf.ms + WEEK_OFFSET;
    default:
      return Math.floor(t / tf.ms) * tf.ms;
  }
}

/** Start of the next `tf` bar after the one starting at `start`. */
export function nextTf(tf: Tf, start: number): number {
  if (tf.unit !== "M") return start + tf.ms;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + tf.k, 1);
}

/** Chart bars folded into `tf` bars (open of the first, high/low extremes, close of the last, volume summed). */
export function foldBars(bars: PineBar[], tf: Tf): PineBar[] {
  const out: PineBar[] = [];
  for (const b of bars) {
    const t = floorTf(tf, b.time);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume = isNa(last.volume) ? b.volume : isNa(b.volume) ? last.volume : last.volume + b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

/** A Pine matrix: its rows, and the column count (kept for empty matrices). */
/** The most frequent value; the smallest of equally frequent ones. */
function modeOf(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) if (!isNa(x)) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = NaN;
  let n = 0;
  for (const [v, c] of counts) if (c > n || (c === n && v < best)) [best, n] = [v, c];
  return best;
}
function varianceOf(xs: number[], biased = true): number {
  const v = xs.filter((x) => !isNa(x));
  if (v.length === 0) return NaN;
  const mean = v.reduce((a, x) => a + x, 0) / v.length;
  return v.reduce((a, x) => a + (x - mean) ** 2, 0) / (biased ? v.length : v.length - 1);
}
/**
 * Linear interpolation between the two nearest ranks, with each value at the
 * middle of its rank (position p/100·n − 0.5), as TradingView's export shows.
 */
function percentileLinear(xs: number[], p: number): number {
  const v = xs.filter((x) => !isNa(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const r = Math.min(v.length - 1, Math.max(0, (Math.min(100, Math.max(0, p)) / 100) * v.length - 0.5));
  const lo = Math.floor(r);
  return v[lo]! + (v[Math.min(lo + 1, v.length - 1)]! - v[lo]!) * (r - lo);
}
function percentileNearest(xs: number[], p: number): number {
  const v = xs.filter((x) => !isNa(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  return v[Math.max(0, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * v.length) - 1)]!;
}

/** Pivot levels of one completed period, by type, in ta.pivot_point_levels' order. */
function pivotLevels(type: string, p: { o: number; h: number; l: number; c: number }, nextOpen: number): number[] {
  const { o, h, l, c } = p;
  const r = h - l;
  const na = NaN;
  switch (type.toLowerCase()) {
    case "fibonacci": {
      const pp = (h + l + c) / 3;
      return [pp, pp + 0.382 * r, pp - 0.382 * r, pp + 0.618 * r, pp - 0.618 * r, pp + r, pp - r, na, na, na, na];
    }
    case "woodie": {
      const pp = (h + l + 2 * nextOpen) / 4;
      const r3 = h + 2 * (pp - l);
      const s3 = l - 2 * (h - pp);
      return [pp, 2 * pp - l, 2 * pp - h, pp + r, pp - r, r3, s3, r3 + r, s3 - r, na, na];
    }
    case "classic": {
      const pp = (h + l + c) / 3;
      return [pp, 2 * pp - l, 2 * pp - h, pp + r, pp - r, pp + 2 * r, pp - 2 * r, pp + 3 * r, pp - 3 * r, na, na];
    }
    case "dm": {
      const x = c < o ? h + 2 * l + c : c > o ? 2 * h + l + c : h + l + 2 * c;
      return [x / 4, x / 2 - l, x / 2 - h, na, na, na, na, na, na, na, na];
    }
    case "camarilla": {
      const pp = (h + l + c) / 3;
      const k = 1.1 * r;
      const r5 = (h / l) * c;
      return [pp, c + k / 12, c - k / 12, c + k / 6, c - k / 6, c + k / 4, c - k / 4, c + k / 2, c - k / 2, r5, c - (r5 - c)];
    }
    default: {
      // Traditional.
      const pp = (h + l + c) / 3;
      return [pp, 2 * pp - l, 2 * pp - h, pp + r, pp - r, pp * 2 + (h - 2 * l), pp * 2 - (2 * h - l), pp * 3 + (h - 3 * l), pp * 3 - (3 * h - l), pp * 4 + (h - 4 * l), pp * 4 - (4 * h - l)];
    }
  }
}

/** A Pine table cell. */
interface Cell {
  col: number;
  row: number;
  text: string;
  textColor: unknown;
  bgcolor: unknown;
}
const cellOf = (t: unknown, column: number, row: number) => (t && typeof t === "object" ? ((t as { cells?: Map<string, Cell> }).cells?.get(`${row}|${column}`) ?? null) : null);
/** A cell's tone: its text colour's, else its background's. */
const cellTone = (c: Cell): Tone | null => toneOf(c.textColor) ?? toneOf(c.bgcolor);

/** A point on the chart: chart.point.* */
export interface ChartPoint {
  time: number;
  index: number;
  price: number;
}
const isPoint = (x: unknown): x is ChartPoint => !!x && typeof x === "object" && "price" in x && ("index" in x || "time" in x);

export class PineMatrix {
  constructor(
    public cells: unknown[][],
    public cols: number,
  ) {}
  /** \`for row in m\`: its rows, as arrays. */
  *[Symbol.iterator]() {
    for (const row of this.cells) yield [...row];
  }
}

// ---------------- the runtime ----------------

interface PlotLine {
  title: string;
  values: (number | null)[];
  colors: unknown[];
  width: number;
  style: "solid" | "dashed" | "step" | "bodies" | "dots";
  /** display.none: computed (and exported to fills), not drawn. */
  hidden: boolean;
}
interface Drawn {
  deleted: boolean;
  [k: string]: unknown;
}

export class Pine {
  i = 0;
  readonly n: number;
  readonly bars: PineBar[];
  readonly opts: PineOptions;
  private readonly plots = new Map<string, PlotLine>();
  private readonly levels = new Map<string, { value: number; title: string; tone: Tone; style: "solid" | "dashed" }>();
  private readonly fillSites = new Map<string, { from: unknown; to: unknown; colors: unknown[] }>();
  private readonly shapes: { index: number; price?: number; shape: string; tone: Tone; text?: string; placement?: "above" | "below" }[] = [];
  private readonly bodies: { index: number; top: number; bottom: number; tone: Tone }[] = [];
  /** \`bgcolor\`: a tone per bar for the pane's background; \`barcolor\`: a tint per candle (+ bull, − bear). */
  private backgrounds: (Tone | null)[] | null = null;
  private tints: (number | null)[] | null = null;
  private readonly events: { index: number; code: string; label: string; tone: Tone }[] = [];
  private readonly labels: Drawn[] = [];
  private readonly lines: Drawn[] = [];
  private readonly boxes: Drawn[] = [];
  private readonly tables: Drawn[] = [];
  /** Set by `indicator(…)`: shown name and where it draws. */
  name = "";
  private readonly times: Map<number, number>;

  constructor(bars: PineBar[], opts: PineOptions) {
    this.bars = bars;
    this.n = bars.length;
    this.opts = opts;
    this.times = new Map(bars.map((b, k) => [b.time, k]));
  }

  bar(i: number) {
    this.i = i;
    if (this.strategy.enabled) this.strategy.step(i);
  }

  get mintick() {
    return this.opts.mintick ?? 0.01;
  }

  /** strategy.*: orders placed while a bar is computed fill as TradingView's broker emulator would. */
  readonly strategy: Broker = new Broker(this);

  /** The strategy's own results, or null for an indicator. */
  strategyReport(): StrategyReport | null {
    return this.strategy.enabled ? this.strategy.report() : null;
  }

  // ---------- built-in series ----------
  private b(k = 0): PineBar | undefined {
    return this.bars[this.i - k];
  }
  get open() { return this.b()?.open ?? NaN; }
  get high() { return this.b()?.high ?? NaN; }
  get low() { return this.b()?.low ?? NaN; }
  get close() { return this.b()?.close ?? NaN; }
  get volume() { return this.b()?.volume ?? NaN; }
  get time() { return this.b()?.time ?? NaN; }
  get time_close() { return this.time + this.opts.periodMs; }
  get bar_index() { return this.i; }
  get last_bar_index() { return this.n - 1; }
  get last_bar_time() { return this.bars[this.n - 1]?.time ?? NaN; }

  /**
   * `timestamp(dateString)`, `timestamp(year, month, day, hour, minute, second)`
   * or `timestamp(timezone, year, …)`: UNIX ms. Without a timezone, the
   * exchange's: UTC for the crypto markets the Terminal shows.
   */
  timestamp(...args: unknown[]): number {
    if (args.length === 1 && typeof args[0] === "string") {
      const t = Date.parse(args[0]);
      return Number.isNaN(t) ? NaN : t;
    }
    const tz = typeof args[0] === "string" ? (args.shift() as string) : "UTC";
    const [y, mo, d, h = 0, mi = 0, sec = 0] = args.map((x) => Number(x));
    if ([y, mo, d].some((x) => x === undefined || Number.isNaN(x))) return NaN;
    const local = Date.UTC(y!, mo! - 1, d!, h, mi, sec);
    return local - tzOffset(tz, local - tzOffset(tz, local));
  }
  get hl2() { return this.src("hl2"); }
  get hlc3() { return this.src("hlc3"); }
  get ohlc4() { return this.src("ohlc4"); }
  get hlcc4() { return this.src("hlcc4"); }

  /** A calendar field of a time (this bar's by default), in UTC: Pine's hour, dayofweek (1 = Sunday), month… */
  dt(field: string, t: number = this.time): number {
    if (isNa(t)) return NaN;
    const d = new Date(t);
    switch (field) {
      case "year": return d.getUTCFullYear();
      case "month": return d.getUTCMonth() + 1;
      case "dayofmonth": return d.getUTCDate();
      case "dayofweek": return d.getUTCDay() + 1;
      case "hour": return d.getUTCHours();
      case "minute": return d.getUTCMinutes();
      case "second": return d.getUTCSeconds();
      case "weekofyear": {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        return Math.floor((t - start) / 604_800_000) + 1;
      }
      default: return NaN;
    }
  }

  /** `time(tf)` / `time_close(tf)`: this bar's time, or the start (end) of the bar of `tf` it falls in (UTC). */
  timeAt(tf: unknown, close = false): number {
    const t = this.time;
    const f = parseTf(tf);
    if (!f || f.ms <= this.opts.periodMs) return close ? t + this.opts.periodMs : t;
    const start = floorTf(f, t);
    return close ? nextTf(f, start) : start;
  }

  /** `timeframe.from_seconds(s)`: the timeframe string Pine would give for that many seconds. */
  tfFromSeconds(sec: number): string {
    if (isNa(sec)) return "";
    if (sec % 2_592_000 === 0) return `${sec / 2_592_000}M`;
    if (sec % 604_800 === 0) return `${sec / 604_800}W`;
    if (sec % 86_400 === 0) return `${sec / 86_400}D`;
    if (sec % 60 === 0) return String(sec / 60);
    return `${sec}S`;
  }

  /** `timeframe.change(tf)`: this bar opens a new `tf` bar. */
  tfChange(tf: unknown): boolean {
    const f = parseTf(tf);
    if (!f) return true;
    const prev = this.bars[this.i - 1];
    return !prev || floorTf(f, prev.time) !== floorTf(f, this.time);
  }

  // ---------- request.security (same market, higher timeframes) ----------

  /** The converted script itself, so request.security can run it again on higher-timeframe bars. */
  exec: ((P: Pine) => void) | null = null;
  /** Higher timeframes this run asked for (tfKey form), so a host can supply their own bars and run again. */
  readonly requested = new Set<string>();
  /** Running on a higher timeframe for request.security: each call there records its value. */
  private htf = false;
  private readonly records = new Map<string, unknown[]>();
  private readonly htfRuns = new Map<string, { q: Pine; index: Int32Array; last: Uint8Array; first: Uint8Array }>();

  /**
   * `request.security(syminfo.tickerid, tf, expr, gaps, lookahead)` for this
   * market. The script runs once on the `tf` bars (in which `expr` is what it
   * reads there), then on each chart bar, as TradingView does on history:
   * - lookahead off: the last finished `tf` bar's value; the live bar sees the forming one;
   * - lookahead on: the value of the `tf` bar this chart bar is in (with `expr[1]`: the previous one);
   * - gaps on: a value only on the chart bar where it arrives, na elsewhere.
   */
  sec(site: string, tf: unknown, expr: () => unknown, lookahead?: unknown, gaps?: unknown): unknown {
    if (this.htf) {
      const v = expr();
      let r = this.records.get(site);
      if (!r) this.records.set(site, (r = []));
      r[this.i] = v;
      return v;
    }
    const f = parseTf(tf);
    if (!f || Math.abs(f.ms - this.opts.periodMs) < 1000) return expr();
    this.requested.add(tfKey(f));
    if (f.ms < this.opts.periodMs) return this.lowerSec(site, f, expr);
    return this.read(this.htfRun(tfKey(f), f), site, lookahead, gaps);
  }

  /** Markets a script asked for that aren't the chart's, by market key: the host supplies their bars where it carries them. */
  readonly markets = new Set<string>();
  private readonly marketRuns = new Map<string, { q: Pine; index: Int32Array; last: Uint8Array; first: Uint8Array }>();

  /** `request.security(symbol, …)` for any symbol: the chart's own market goes to `sec`. */
  secm(site: string, symbol: unknown, tf: unknown, expr: () => unknown, lookahead?: unknown, gaps?: unknown): unknown {
    if (this.htf) return this.sec(site, tf, expr, lookahead, gaps);
    const key = marketKey(symbol);
    const own = marketKey(this.opts.symbol ?? "");
    // No market named, or this chart's: as on this market (its Heikin Ashi bars for ticker.heikinashi).
    if (!key || key === own) return this.sec(site, tf, expr, lookahead, gaps);
    if (key === `HA:${own}`) return this.read(this.heikinRun(tf), site, lookahead, gaps);
    this.markets.add(key);
    const base = this.opts.markets?.[key];
    if (!base?.length) {
      // Not carried (or not here yet): na, shaped like the expression's value.
      const v = expr();
      return Array.isArray(v) ? v.map(() => NaN) : NaN;
    }
    const f = parseTf(tf);
    const g = f && f.ms > this.opts.periodMs + 999 ? f : null;
    if (f && f.ms < this.opts.periodMs - 999) this.approximated.add(`${key}|${tfKey(f)}`);
    const runKey = `${key}|${g ? tfKey(g) : "chart"}`;
    let run = this.marketRuns.get(runKey);
    if (!run) {
      const bars = base.map((b) => ({ ...b, volume: b.volume ?? NaN }));
      run = this.alignedRun(g ? foldBars(bars, g) : bars, g, g ? g.ms : this.opts.periodMs);
      this.marketRuns.set(runKey, run);
    }
    return this.read(run, site, lookahead, gaps);
  }

  /** The script on Heikin Ashi bars made from the chart's own (ticker.heikinashi). */
  private heikinRun(tf: unknown) {
    const f = parseTf(tf);
    const g = f && f.ms > this.opts.periodMs + 999 ? f : null;
    const runKey = `HA|${g ? tfKey(g) : "chart"}`;
    let run = this.marketRuns.get(runKey);
    if (!run) {
      const ha = heikinAshi(this.bars);
      run = this.alignedRun(g ? foldBars(ha, g) : ha, g, g ? g.ms : this.opts.periodMs);
      this.marketRuns.set(runKey, run);
    }
    return run;
  }

  /** Run the script on `bars` (of timeframe `f`, or the chart's when null) and line each chart bar up with its bar there. */
  private alignedRun(bars: PineBar[], f: Tf | null, periodMs: number) {
    const q = new Pine(bars, { ...this.opts, periodMs, higher: {}, markets: {} });
    q.htf = true;
    q.exec = this.exec;
    if (!this.exec) throw new Error("request.security needs the script to run again; this module can't");
    this.exec(q);
    const index = new Int32Array(this.n);
    const last = new Uint8Array(this.n);
    const first = new Uint8Array(this.n);
    const starts = this.bars.map((b) => (f ? floorTf(f, b.time) : b.time));
    for (let i = 0; i < this.n; i++) {
      index[i] = q.times.get(starts[i]!) ?? -1;
      last[i] = !f || (i < this.n - 1 && starts[i + 1] !== starts[i]) ? 1 : 0;
      first[i] = !f || i === 0 || starts[i - 1] !== starts[i] ? 1 : 0;
    }
    return { q, index, last, first };
  }

  /**
   * \`request.security_lower_tf\`: the values on every bar of the lower
   * timeframe inside each chart bar, as an array. Without those bars, the
   * chart bar's own value alone.
   */
  secLower(site: string, symbol: unknown, tf: unknown, expr: () => unknown): unknown[] {
    if (this.htf) {
      const v = expr();
      let r = this.records.get(site);
      if (!r) this.records.set(site, (r = []));
      r[this.i] = v;
      return [v];
    }
    const key = marketKey(symbol);
    const own = marketKey(this.opts.symbol ?? "");
    if (key && own && key !== own) {
      this.markets.add(key);
      return [];
    }
    const f = parseTf(tf);
    if (!f || f.ms >= this.opts.periodMs) return [expr()];
    this.requested.add(tfKey(f));
    const run = this.ltfRun(tfKey(f), f);
    if (!run) {
      this.approximated.add(tfKey(f));
      return [expr()];
    }
    const vals = run.q.records.get(site) ?? [];
    const out: unknown[] = [];
    for (let j = run.from[this.i]!; j >= 0 && j <= run.index[this.i]!; j++) if (vals[j] !== undefined) out.push(vals[j]);
    return out;
  }

  private read(run: { q: Pine; index: Int32Array; last: Uint8Array; first: Uint8Array }, site: string, lookahead?: unknown, gaps?: unknown): unknown {
    const vals = run.q.records.get(site) ?? [];
    const naLike = () => {
      const sample = vals.find((v) => v !== undefined);
      return Array.isArray(sample) ? sample.map(() => NaN) : NaN;
    };
    const at = (j: number) => (j >= 0 && vals[j] !== undefined ? vals[j] : naLike());
    const j = run.index[this.i]!;
    const gapsOn = String(gaps ?? "").endsWith("gaps_on");
    if (String(lookahead ?? "").endsWith("lookahead_on")) return gapsOn && !run.first[this.i] ? naLike() : at(j);
    const done = run.last[this.i] === 1 || this.i === this.n - 1;
    if (gapsOn) return done ? at(j) : naLike();
    return done ? at(j) : at(j - 1);
  }

  /** Timeframes read below the chart's without their bars: computed on the chart's own bars instead. */
  readonly approximated = new Set<string>();
  private readonly ltfRuns = new Map<string, { q: Pine; index: Int32Array; from: Int32Array } | null>();

  /** The script on a lower timeframe's supplied bars; per chart bar, the first and last of its bars inside it (-1: none). */
  private ltfRun(key: string, f: Tf) {
    let run = this.ltfRuns.get(key);
    if (run !== undefined) return run;
    const supplied = Object.entries(this.opts.higher ?? {}).find(([k]) => {
      const g = parseTf(k);
      return g !== null && tfKey(g) === key;
    })?.[1];
    run = null;
    if (supplied?.length && this.exec) {
      const q = new Pine(supplied.map((b) => ({ ...b, volume: b.volume ?? NaN })), { ...this.opts, periodMs: f.ms, higher: {}, markets: {} });
      q.htf = true;
      q.exec = this.exec;
      this.exec(q);
      const index = new Int32Array(this.n).fill(-1);
      const from = new Int32Array(this.n).fill(-1);
      let j = 0;
      for (let i = 0; i < this.n; i++) {
        const start = this.bars[i]!.time;
        const end = start + this.opts.periodMs;
        while (j < q.n && q.bars[j]!.time < start) j++;
        const first = j;
        while (j < q.n && q.bars[j]!.time < end) j++;
        if (j > first) [from[i], index[i]] = [first, j - 1];
      }
      run = { q, index, from };
    }
    this.ltfRuns.set(key, run);
    return run;
  }

  /**
   * A lower timeframe, as TradingView answers it on history: the value on the
   * last of its bars inside each chart bar (na before its bars begin). Without
   * those bars, the expression on the chart's own bars.
   */
  private lowerSec(site: string, f: Tf, expr: () => unknown): unknown {
    const run = this.ltfRun(tfKey(f), f);
    if (!run) {
      this.approximated.add(tfKey(f));
      return expr();
    }
    const vals = run.q.records.get(site) ?? [];
    const j = run.index[this.i]!;
    if (j >= 0 && vals[j] !== undefined) return vals[j];
    const sample = vals.find((v) => v !== undefined);
    return Array.isArray(sample) ? sample.map(() => NaN) : NaN;
  }

  private htfRun(key: string, f: Tf) {
    let run = this.htfRuns.get(key);
    if (run) return run;
    // Older history from the higher timeframe's own bars where given; from the chart's first bar on, the chart's bars folded,
    // so the forming bar is exactly what the chart has seen (and replay never sees ahead).
    const folded = foldBars(this.bars, f);
    const firstStart = folded[0]?.time ?? Infinity;
    const supplied = Object.entries(this.opts.higher ?? {}).find(([k]) => {
      const g = parseTf(k);
      return g !== null && tfKey(g) === key;
    })?.[1];
    const given = (supplied ?? []).filter((b) => b.time < firstStart).map((b) => ({ ...b, volume: b.volume ?? NaN }));
    const q = new Pine([...given, ...folded], { ...this.opts, periodMs: f.ms, higher: {} });
    q.htf = true;
    q.exec = this.exec;
    if (!this.exec) throw new Error("request.security needs the script to run again; this module can't");
    this.exec(q);
    const index = new Int32Array(this.n);
    const last = new Uint8Array(this.n);
    const first = new Uint8Array(this.n);
    const starts = this.bars.map((b) => floorTf(f, b.time));
    for (let i = 0; i < this.n; i++) {
      index[i] = q.times.get(starts[i]!) ?? -1;
      last[i] = i < this.n - 1 && starts[i + 1] !== starts[i] ? 1 : 0;
      first[i] = i === 0 || starts[i - 1] !== starts[i] ? 1 : 0;
    }
    run = { q, index, last, first };
    this.htfRuns.set(key, run);
    return run;
  }

  /** A price source `k` bars back, by name (`close`, `hl2`, …), as `input.source` gives them. */
  src(name: string, k = 0): number {
    const b = this.b(k);
    if (!b) return NaN;
    switch (name) {
      case "open": return b.open;
      case "high": return b.high;
      case "low": return b.low;
      case "close": return b.close;
      case "volume": return b.volume;
      case "time": return b.time;
      case "hl2": return (b.high + b.low) / 2;
      case "hlc3": return (b.high + b.low + b.close) / 3;
      case "ohlc4": return (b.open + b.high + b.low + b.close) / 4;
      case "hlcc4": return (b.high + b.low + 2 * b.close) / 4;
      case "bar_index": return this.i - k;
      default: return NaN;
    }
  }

  readonly barstate = (() => {
    const self = this;
    return {
      get isfirst() { return self.i === 0; },
      get islast() { return self.i === self.n - 1; },
      get ishistory() { return self.i < self.n - 1; },
      get isrealtime() { return self.i === self.n - 1; },
      get isnew() { return true; },
      get isconfirmed() { return self.i < self.n - 1; },
      get islastconfirmedhistory() { return self.i === self.n - 2; },
    };
  })();

  get syminfo() {
    const own = this.opts.symbol ?? "";
    return { mintick: this.opts.mintick ?? 0.01, ticker: own, tickerid: own, prefix: "", root: own, description: own, type: "crypto", currency: "USD", basecurrency: own.replace(/USD$/, ""), pointvalue: 1, timezone: "Etc/UTC", session: "24x7", volumetype: "base" };
  }

  get timeframe() {
    const ms = this.opts.periodMs;
    const min = Math.round(ms / 60_000);
    const period = ms >= 28 * 86_400_000 ? "M" : ms >= 7 * 86_400_000 ? "W" : ms >= 86_400_000 ? "D" : String(min);
    return {
      period,
      multiplier: period === "M" || period === "W" || period === "D" ? 1 : min,
      isintraday: ms < 86_400_000,
      isdaily: period === "D",
      isweekly: period === "W",
      ismonthly: period === "M",
      isdwm: ms >= 86_400_000,
      isminutes: ms < 86_400_000 && ms >= 60_000,
      isseconds: ms < 60_000,
      /** Seconds in `tf` (the chart's when left out); a month counts 30 days, as Pine's does. */
      in_seconds: (tf?: unknown) => (parseTf(tf)?.ms ?? ms) / 1000,
    };
  }

  // ---------- history ----------

  /** A variable's values bar by bar, for `x[k]`. */
  ser() {
    const h: unknown[] = [];
    return {
      set: (v: unknown) => {
        h[this.i] = v;
        return v;
      },
      get: (k: number) => {
        const j = this.i - Math.round(k);
        return j < 0 ? NaN : (h[j] ?? NaN);
      },
    };
  }

  /** `expr[k]` for an expression: its value is kept per bar at this place in the script. */
  hist(st: St, v: unknown, k: number): unknown {
    const h = (st.h ??= []) as unknown[];
    h[this.i] = v;
    const j = this.i - Math.round(k);
    return j < 0 ? NaN : (h[j] ?? NaN);
  }

  /** `fixnan(x)`: the last non-na value at this place. */
  fixnan(st: St, x: unknown) {
    if (!isNa(x)) st.v = x;
    return (st.v as number | undefined) ?? NaN;
  }

  // ---------- ta.* (stateful, per call site) ----------

  private push(st: St, x: number, key = "b"): number[] {
    const b = ((st as Record<string, unknown>)[key] ??= []) as number[];
    b.push(typeof x === "boolean" ? (x ? 1 : 0) : (x as number));
    return b;
  }
  /** The last `len` values pushed here, or null until there are that many. */
  private window(st: St, x: number, len: number, key = "b"): number[] | null {
    const b = this.push(st, x, key);
    const n = Math.max(1, Math.round(len));
    return b.length < n ? null : b.slice(-n);
  }
  private smoothStep(st: St, x: number, len: number, alpha: number): number {
    // Pine's seeding, as ta.ts `smoothed`: the SMA of the first `len` values, then exponential; na restarts the seed.
    if (isNa(x)) {
      st.prev = NaN;
      st.sum = 0;
      st.count = 0;
      return NaN;
    }
    if (isNa(st.prev)) {
      st.sum = ((st.sum as number) ?? 0) + x;
      st.count = ((st.count as number) ?? 0) + 1;
      if ((st.count as number) === len) {
        st.prev = (st.sum as number) / len;
        return st.prev as number;
      }
      return NaN;
    }
    st.prev = alpha * x + (1 - alpha) * (st.prev as number);
    return st.prev as number;
  }
  private sub(st: St, key: string): St {
    return ((st as Record<string, unknown>)[key] ??= { prev: NaN }) as St;
  }
  private trNow(handleNa: boolean): number {
    const b = this.b();
    if (!b) return NaN;
    const pc = this.b(1)?.close;
    const hl = b.high - b.low;
    if (pc === undefined) return handleNa ? hl : NaN;
    return Math.max(hl, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }

  readonly ta = (() => {
    const self = this;
    const lastOf = (s: number[]) => last(s);
    const win = (st: St, x: number, len: number, fn: (w: number[], n: number) => number[]) => {
      const w = self.window(st, x, len);
      return w ? lastOf(fn(w, w.length)) : NaN;
    };
    const ta = {
      get tr() { return self.trNow(false); },
      get vwap() { return self.taVar("vwap"); },
      get obv() { return self.taVar("obv"); },
      get accdist() { return self.taVar("accdist"); },
      get pvt() { return self.taVar("pvt"); },
      get pvi() { return self.taVar("pvi"); },
      get nvi() { return self.taVar("nvi"); },
      get wad() { return self.taVar("wad"); },
      // Checked against TradingView's export: the position in the range, times volume.
      get iii() { const b = self.b()!; return ((2 * b.close - b.high - b.low) / (b.high - b.low)) * b.volume; },
      get wvad() { const b = self.b()!; return ((b.close - b.open) / (b.high - b.low)) * b.volume; },
      trf: (handleNa = false) => self.trNow(handleNa),
      sma: (st: St, x: number, len: number) => win(st, x, len, (w, n) => vec.sma(w, n)),
      wma: (st: St, x: number, len: number) => win(st, x, len, (w, n) => vec.wma(w, n)),
      stdev: (st: St, x: number, len: number, biased = true) => win(st, x, len, (w, n) => vec.stdev(w, n, biased)),
      median: (st: St, x: number, len: number) => win(st, x, len, (w, n) => vec.median(w, n)),
      dev: (st: St, x: number, len: number) => win(st, x, len, (w, n) => vec.dev(w, n)),
      highest: (st: St, x: number, len: number) => win(st, x, len, (w, n) => vec.highest(w, n)),
      lowest: (st: St, x: number, len: number) => win(st, x, len, (w, n) => vec.lowest(w, n)),
      highestbars: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len);
        if (!w) return NaN;
        let k = 0;
        for (let j = 1; j < w.length; j++) if (w[j]! >= w[k]!) k = j;
        return k - (w.length - 1);
      },
      lowestbars: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len);
        if (!w) return NaN;
        let k = 0;
        for (let j = 1; j < w.length; j++) if (w[j]! <= w[k]!) k = j;
        return k - (w.length - 1);
      },
      linreg: (st: St, x: number, len: number, offset = 0) => win(st, x, len, (w, n) => vec.linreg(w, n, offset)),
      percentrank: (st: St, x: number, len: number) => win(st, x, len + 1, (w) => vec.percentrank(w, len)),
      percentile_nearest_rank: (st: St, x: number, len: number, p: number) => win(st, x, len, (w, n) => vec.percentileNearestRank(w, n, p)),
      sum: (st: St, x: number, len: number) => win(st, x, len, (w, n) => vec.sum(w, n)),
      cum: (st: St, x: number) => (st.total = ((st.total as number) ?? 0) + (nz(x) as number)) as number,
      ema: (st: St, x: number, len: number) => self.smoothStep(st, x, len, 2 / (len + 1)),
      rma: (st: St, x: number, len: number) => self.smoothStep(st, x, len, 1 / len),
      change: (st: St, x: number, len = 1) => {
        const b = self.push(st, x);
        return x - (b[b.length - 1 - len] ?? NaN);
      },
      mom: (st: St, x: number, len: number) => ta.change(st, x, len),
      roc: (st: St, x: number, len: number) => {
        const b = self.push(st, x);
        const prev = b[b.length - 1 - len] ?? NaN;
        return (100 * (x - prev)) / prev;
      },
      rsi: (st: St, x: number, len: number) => {
        const prev = (st.px as number | undefined) ?? NaN;
        st.px = x;
        const ch = x - prev;
        const u = self.smoothStep(self.sub(st, "u"), isNa(ch) ? NaN : Math.max(ch, 0), len, 1 / len);
        const d = self.smoothStep(self.sub(st, "d"), isNa(ch) ? NaN : Math.max(-ch, 0), len, 1 / len);
        if (isNa(u) || isNa(d)) return NaN;
        return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
      },
      macd: (st: St, x: number, fast: number, slow: number, signal: number) => {
        const f = self.smoothStep(self.sub(st, "f"), x, fast, 2 / (fast + 1));
        const s = self.smoothStep(self.sub(st, "s"), x, slow, 2 / (slow + 1));
        const line = f - s;
        const sig = self.smoothStep(self.sub(st, "g"), line, signal, 2 / (signal + 1));
        return [line, sig, line - sig];
      },
      bb: (st: St, x: number, len: number, mult: number) => {
        const w = self.window(st, x, len);
        if (!w) return [NaN, NaN, NaN];
        const basis = last(vec.sma(w, w.length));
        const d = last(vec.stdev(w, w.length));
        return [basis, basis + mult * d, basis - mult * d];
      },
      bbw: (st: St, x: number, len: number, mult: number) => {
        const [basis, upper, lower] = ta.bb(st, x, len, mult) as number[];
        return ((upper! - lower!) / basis!) * 100;
      },
      stoch: (st: St, src: number, high: number, low: number, len: number) => {
        const hh = win(self.sub(st, "h"), high, len, (w, n) => vec.highest(w, n));
        const ll = win(self.sub(st, "l"), low, len, (w, n) => vec.lowest(w, n));
        const range = hh - ll;
        return isNa(range) || isNa(src) || range === 0 ? NaN : (100 * (src - ll)) / range;
      },
      cci: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len);
        if (!w) return NaN;
        const mean = last(vec.sma(w, w.length));
        const d = last(vec.dev(w, w.length));
        return (x - mean) / (0.015 * d);
      },
      vwma: (st: St, x: number, vol: number, len: number) => {
        const a = win(self.sub(st, "xv"), x * vol, len, (w, n) => vec.sma(w, n));
        const b = win(self.sub(st, "v"), vol, len, (w, n) => vec.sma(w, n));
        return a / b;
      },
      atr: (st: St, len: number) => self.smoothStep(st, self.trNow(true), len, 1 / len),
      correlation: (st: St, a: number, b: number, len: number) => {
        const wa = self.window(self.sub(st, "a"), a, len);
        const wb = self.window(self.sub(st, "b"), b, len);
        return wa && wb ? last(vec.correlation(wa, wb, wa.length)) : NaN;
      },
      crossover: (st: St, a: number, b: number) => {
        const pa = st.pa as number | undefined;
        const pb = st.pb as number | undefined;
        st.pa = a;
        st.pb = b;
        return pa !== undefined && a > b && pa <= (pb as number);
      },
      crossunder: (st: St, a: number, b: number) => {
        const pa = st.pa as number | undefined;
        const pb = st.pb as number | undefined;
        st.pa = a;
        st.pb = b;
        return pa !== undefined && a < b && pa >= (pb as number);
      },
      cross: (st: St, a: number, b: number) => {
        const pa = st.pa as number | undefined;
        const pb = st.pb as number | undefined;
        st.pa = a;
        st.pb = b;
        return pa !== undefined && ((a > b && pa <= (pb as number)) || (a < b && pa >= (pb as number)));
      },
      rising: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len + 1);
        return !!w && w.every((v, k) => k === 0 || v > w[k - 1]!);
      },
      falling: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len + 1);
        return !!w && w.every((v, k) => k === 0 || v < w[k - 1]!);
      },
      barssince: (st: St, cond: unknown) => {
        if (truthy(cond)) st.at = self.i;
        return st.at === undefined ? NaN : self.i - (st.at as number);
      },
      valuewhen: (st: St, cond: unknown, src: number, occurrence: number) => {
        const seen = (st.seen ??= []) as number[];
        if (truthy(cond)) seen.push(src);
        return seen[seen.length - 1 - occurrence] ?? NaN;
      },
      pivothigh: (st: St, src: number, left: number, right: number) => win(st, src, left + right + 1, (w) => vec.pivothigh(w, left, right)),
      pivotlow: (st: St, src: number, left: number, right: number) => win(st, src, left + right + 1, (w) => vec.pivotlow(w, left, right)),
      // ---- from the language reference's definitions ----
      /**
       * \`ta.pivot_point_levels(type, anchor, developing)\`: [P, R1, S1, R2, S2, R3, S3, R4, S4, R5, S5]
       * from the last completed anchor period (or the forming one when developing); na where a type has no level.
       */
      pivot_point_levels: (st: St, type: string, anchor: unknown, developing = false) => {
        const b = self.b()!;
        const cur = st.cur as { o: number; h: number; l: number; c: number } | undefined;
        if (truthy(anchor) || !cur) {
          if (cur) st.done = cur;
          st.cur = { o: b.open, h: b.high, l: b.low, c: b.close };
        } else Object.assign(cur, { h: Math.max(cur.h, b.high), l: Math.min(cur.l, b.low), c: b.close });
        const from = (developing ? st.cur : st.done) as { o: number; h: number; l: number; c: number } | undefined;
        if (!from) return new Array<number>(11).fill(NaN);
        return pivotLevels(String(type), from, (st.cur as { o: number }).o);
      },
      cmo: (st: St, x: number, len: number) => {
        const mom = ta.change(self.sub(st, "c"), x, 1);
        const up = ta.sum(self.sub(st, "u"), isNa(mom) ? NaN : mom >= 0 ? mom : 0, len);
        const down = ta.sum(self.sub(st, "d"), isNa(mom) ? NaN : mom >= 0 ? 0 : -mom, len);
        return (100 * (up - down)) / (up + down);
      },
      max: (st: St, x: number) => {
        if (!isNa(x)) st.m = isNa(st.m ?? NaN) ? x : Math.max(st.m as number, x);
        return (st.m as number | undefined) ?? NaN;
      },
      min: (st: St, x: number) => {
        if (!isNa(x)) st.m = isNa(st.m ?? NaN) ? x : Math.min(st.m as number, x);
        return (st.m as number | undefined) ?? NaN;
      },
      mode: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len);
        return w ? modeOf(w) : NaN;
      },
      percentile_linear_interpolation: (st: St, x: number, len: number, p: number) => {
        const w = self.window(st, x, len);
        return w ? percentileLinear(w, p) : NaN;
      },
      variance: (st: St, x: number, len: number, biased = true) => {
        const w = self.window(st, x, len);
        return w ? varianceOf(w, biased) : NaN;
      },
      swma: (st: St, x: number) => {
        const w = self.window(st, x, 4);
        return w ? w[0]! / 6 + (w[1]! * 2) / 6 + (w[2]! * 2) / 6 + w[3]! / 6 : NaN;
      },
      tsi: (st: St, x: number, short: number, long: number) => {
        const pc = ta.change(self.sub(st, "c"), x, 1);
        const num = ta.ema(self.sub(st, "n2"), ta.ema(self.sub(st, "n1"), pc, long), short);
        const den = ta.ema(self.sub(st, "d2"), ta.ema(self.sub(st, "d1"), Math.abs(pc), long), short);
        return num / den;
      },
      rci: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len);
        if (!w) return NaN;
        const n = w.length;
        // Time rank 1 for the newest bar; price rank 1 for the highest price (ties share their average rank).
        const order = w.map((v, k) => ({ v, k })).sort((a, b) => b.v - a.v);
        const priceRank = new Array<number>(n);
        for (let i = 0; i < n; ) {
          let j = i;
          while (j + 1 < n && order[j + 1]!.v === order[i]!.v) j++;
          for (let k = i; k <= j; k++) priceRank[order[k]!.k] = (i + j) / 2 + 1;
          i = j + 1;
        }
        let d2 = 0;
        for (let k = 0; k < n; k++) d2 += (n - k - priceRank[k]!) ** 2;
        return (1 - (6 * d2) / (n * (n * n - 1))) * 100;
      },
      sar: (st: St, start: number, inc: number, max: number) => {
        const b = self.b()!;
        const p1 = self.b(1);
        const p2 = self.b(2);
        const n = (st.n = ((st.n as number) ?? -1) + 1) as number;
        if (n === 0 || !p1) return NaN;
        let result = st.result as number;
        let maxMin = st.maxMin as number;
        let acc = st.acc as number;
        let below = st.below as boolean;
        let firstTrendBar = false;
        if (n === 1) {
          if (b.close > p1.close) [below, maxMin, result] = [true, b.high, p1.low];
          else [below, maxMin, result] = [false, b.low, p1.high];
          firstTrendBar = true;
          acc = start;
        }
        result = result + acc * (maxMin - result);
        if (below) {
          if (result > b.low) [firstTrendBar, below, result, maxMin, acc] = [true, false, Math.max(b.high, maxMin), b.low, start];
        } else if (result < b.high) [firstTrendBar, below, result, maxMin, acc] = [true, true, Math.min(b.low, maxMin), b.high, start];
        if (!firstTrendBar) {
          if (below) {
            if (b.high > maxMin) [maxMin, acc] = [b.high, Math.min(acc + inc, max)];
          } else if (b.low < maxMin) [maxMin, acc] = [b.low, Math.min(acc + inc, max)];
        }
        if (below) {
          result = Math.min(result, p1.low);
          if (n > 1 && p2) result = Math.min(result, p2.low);
        } else {
          result = Math.max(result, p1.high);
          if (n > 1 && p2) result = Math.max(result, p2.high);
        }
        Object.assign(st, { result, maxMin, acc, below });
        return result;
      },
      hma: (st: St, x: number, len: number) => {
        const half = ta.wma(self.sub(st, "h"), x, Math.floor(len / 2));
        const full = ta.wma(self.sub(st, "f"), x, len);
        return ta.wma(self.sub(st, "o"), 2 * half - full, Math.floor(Math.sqrt(len)));
      },
      alma: (st: St, x: number, len: number, offset: number, sigma: number, floor = false) => {
        const w = self.window(st, x, len);
        if (!w) return NaN;
        const n = w.length;
        const m = floor ? Math.floor(offset * (n - 1)) : offset * (n - 1);
        const s = n / sigma;
        let norm = 0;
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const weight = Math.exp(-((i - m) ** 2) / (2 * s * s));
          norm += weight;
          sum += w[i]! * weight;
        }
        return sum / norm;
      },
      supertrend: (st: St, factor: number, atrLen: number) => {
        const b = self.b()!;
        const atr = self.smoothStep(self.sub(st, "a"), self.trNow(true), atrLen, 1 / atrLen);
        const src = (b.high + b.low) / 2;
        let upper = src + factor * atr;
        let lower = src - factor * atr;
        const prevLower = nz(st.lower as number) as number;
        const prevUpper = nz(st.upper as number) as number;
        const prevClose = self.b(1)?.close ?? NaN;
        lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
        upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
        const prevSt = (st.st as number | undefined) ?? NaN;
        const dir = isNa(st.atr1 ?? NaN) ? 1 : prevSt === prevUpper ? (b.close > upper ? -1 : 1) : b.close < lower ? 1 : -1;
        const value = dir === -1 ? lower : upper;
        Object.assign(st, { lower, upper, st: value, atr1: atr });
        return [value, dir];
      },
      mfi: (st: St, x: number, len: number) => {
        const ch = ta.change(self.sub(st, "c"), x, 1);
        const vol = self.b()?.volume ?? NaN;
        const up = ta.sum(self.sub(st, "u"), vol * (ch <= 0 ? 0 : x), len);
        const down = ta.sum(self.sub(st, "d"), vol * (ch >= 0 ? 0 : x), len);
        return 100 - 100 / (1 + up / down);
      },
      wpr: (st: St, len: number) => {
        const hh = ta.highest(self.sub(st, "h"), self.high, len);
        const ll = ta.lowest(self.sub(st, "l"), self.low, len);
        return (100 * (self.close - hh)) / (hh - ll);
      },
      kc: (st: St, x: number, len: number, mult: number, useTrueRange = true) => {
        const basis = ta.ema(self.sub(st, "b"), x, len);
        const range = ta.ema(self.sub(st, "r"), useTrueRange ? self.trNow(false) : self.high - self.low, len);
        return [basis, basis + range * mult, basis - range * mult];
      },
      kcw: (st: St, x: number, len: number, mult: number, useTrueRange = true) => {
        const [basis, upper, lower] = ta.kc(st, x, len, mult, useTrueRange) as number[];
        return (upper! - lower!) / basis!;
      },
      cog: (st: St, x: number, len: number) => {
        const w = self.window(st, x, len);
        if (!w) return NaN;
        let num = 0;
        let sum = 0;
        for (let i = 0; i < w.length; i++) {
          const price = w[w.length - 1 - i]!;
          num += price * (i + 1);
          sum += price;
        }
        return -num / sum;
      },
      range: (st: St, x: number, len: number) => ta.highest(self.sub(st, "h"), x, len) - ta.lowest(self.sub(st, "l"), x, len),
      /** Anchored to each new day (the crypto session) unless `anchor` says when to restart; with `mult`, bands too. */
      vwapf: (st: St, x: number, anchor?: unknown, mult?: number) => {
        const day = Math.floor(self.time / 86_400_000);
        const restart = anchor === undefined ? st.day !== day : truthy(anchor);
        st.day = day;
        const vol = self.b()?.volume ?? NaN;
        if (restart || st.pv === undefined) Object.assign(st, { pv: 0, v: 0, p2v: 0 });
        if (!isNa(x) && !isNa(vol)) {
          st.pv = (st.pv as number) + x * vol;
          st.v = (st.v as number) + vol;
          st.p2v = (st.p2v as number) + x * x * vol;
        }
        const v = st.v as number;
        const vwap = v > 0 ? (st.pv as number) / v : NaN;
        if (mult === undefined) return vwap;
        const dev = Math.sqrt(Math.max(0, (st.p2v as number) / v - vwap * vwap));
        return [vwap, vwap + dev * mult, vwap - dev * mult];
      },
      dmi: (st: St, diLen: number, adxLen: number) => {
        const b = self.b();
        const p = self.b(1);
        const up = b && p ? b.high - p.high : NaN;
        const down = b && p ? p.low - b.low : NaN;
        const plusDM = isNa(up) ? NaN : up > down && up > 0 ? up : 0;
        const minusDM = isNa(down) ? NaN : down > up && down > 0 ? down : 0;
        const trur = self.smoothStep(self.sub(st, "t"), self.trNow(false), diLen, 1 / diLen);
        const plusRaw = (100 * self.smoothStep(self.sub(st, "p"), plusDM, diLen, 1 / diLen)) / trur;
        const minusRaw = (100 * self.smoothStep(self.sub(st, "m"), minusDM, diLen, 1 / diLen)) / trur;
        const plus = self.fixnan(self.sub(st, "fp"), plusRaw);
        const minus = self.fixnan(self.sub(st, "fm"), minusRaw);
        const sum = plus + minus;
        const adx = 100 * self.smoothStep(self.sub(st, "a"), Math.abs(plus - minus) / (sum === 0 ? 1 : sum), adxLen, 1 / adxLen);
        return [plus, minus, adx];
      },
    };
    return ta;
  })();

  /**
   * The cumulative built-in variables (ta.obv, ta.vwap…): one value per bar,
   * brought up to this bar however often (or rarely) the script reads them.
   */
  private readonly taVars = new Map<string, { i: number; v: number; st: St }>();
  private taVar(name: string): number {
    let s = this.taVars.get(name);
    if (!s) this.taVars.set(name, (s = { i: -1, v: NaN, st: { prev: NaN } }));
    const at = this.i;
    while (s.i < at) {
      const k = ++s.i;
      const b = this.bars[k]!;
      const p = this.bars[k - 1];
      const prev = k === 0 ? NaN : s.v;
      switch (name) {
        case "vwap": {
          const saved = this.i;
          this.i = k;
          s.v = this.ta.vwapf(s.st, (b.high + b.low + b.close) / 3) as number;
          this.i = saved;
          break;
        }
        case "obv":
          s.v = (nz(prev) as number) + (p ? Math.sign(b.close - p.close) * b.volume : 0);
          break;
        case "accdist":
          s.v = (nz(prev) as number) + ((b.close === b.high && b.close === b.low) || b.high === b.low ? 0 : ((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume);
          break;
        case "pvt":
          s.v = (nz(prev) as number) + (p ? ((b.close - p.close) / p.close) * b.volume : 0);
          break;
        case "pvi":
        case "nvi": {
          const base = isNa(prev) || prev === 0 ? 1 : prev;
          const moved = p && (name === "pvi" ? b.volume > (nz(p.volume) as number) : b.volume < (nz(p.volume) as number));
          s.v = !p || !b.close || !p.close || !moved ? base : base + ((b.close - p.close) / p.close) * base;
          break;
        }
        case "wad": {
          const gain = !p ? 0 : b.close > p.close ? b.close - Math.min(b.low, p.close) : b.close < p.close ? b.close - Math.max(b.high, p.close) : 0;
          s.v = (nz(prev) as number) + gain;
          break;
        }
      }
    }
    return s.v;
  }

  /** `math.sum`: a series function, so stateful like the ta ones. */
  msum(st: St, x: number, len: number) {
    return this.ta.sum(st, x, len);
  }

  // ---------- strings ----------
  readonly str = (() => {
    const self = this;
    return {
      tostring: (v: unknown, fmt?: string) => (typeof v === "number" ? formatNumber(v, fmt, self.opts.mintick) : typeof v === "boolean" ? String(v) : isNa(v) ? "NaN" : String(v)),
      format: (f: string, ...args: unknown[]) =>
        String(f).replace(/\{(\d+)(?:,number,([^}]+))?\}/g, (_, k: string, pattern?: string) => {
          const v = args[Number(k)];
          return typeof v === "number" ? formatNumber(v, pattern ?? undefined, self.opts.mintick) : String(v ?? "");
        }),
      length: (s: string) => String(s).length,
      upper: (s: string) => String(s).toUpperCase(),
      lower: (s: string) => String(s).toLowerCase(),
      contains: (s: string, sub: string) => String(s).includes(sub),
      startswith: (s: string, sub: string) => String(s).startsWith(sub),
      endswith: (s: string, sub: string) => String(s).endsWith(sub),
      replace_all: (s: string, a: string, b: string) => String(s).split(a).join(b),
      substring: (s: string, from: number, to?: number) => String(s).substring(from, to),
      split: (s: string, sep: string) => String(s).split(sep),
      tonumber: (s: string) => { const v = Number(s); return Number.isFinite(v) ? v : NaN; },
      trim: (s: string) => String(s).trim(),
      pos: (s: string, sub: string) => { const k = String(s).indexOf(String(sub)); return k < 0 ? NaN : k; },
      match: (s: string, re: string) => { try { return new RegExp(String(re)).exec(String(s))?.[0] ?? ""; } catch { return ""; } },
      repeat: (s: string, n: number, sep = "") => Array.from({ length: Math.max(0, Math.trunc(n)) }, () => String(s)).join(sep),
      /** The \`occurrence\`-th (from 0) match of \`target\` replaced. */
      replace: (s: string, target: string, replacement: string, occurrence = 0) => {
        const src = String(s);
        let at = -1;
        for (let k = 0; k <= occurrence; k++) {
          at = src.indexOf(String(target), at + 1);
          if (at < 0) return src;
        }
        return src.slice(0, at) + String(replacement) + src.slice(at + String(target).length);
      },
      /** `str.format_time(time, "yyyy-MM-dd HH:mm")`, in UTC. */
      format_time: (t: number, fmt = "yyyy-MM-dd'T'HH:mm:ssZ") => {
        if (isNa(t)) return "";
        const d = new Date(t);
        const p2 = (n: number) => String(n).padStart(2, "0");
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return String(fmt)
          .replace(/'([^']*)'/g, "\u0000$1\u0000")
          .replace(/yyyy|yy|MMM|MM|dd|EEE|HH|hh|mm|ss|a|Z/g, (k) =>
            k === "yyyy" ? String(d.getUTCFullYear()) : k === "yy" ? String(d.getUTCFullYear()).slice(2) : k === "MMM" ? months[d.getUTCMonth()]! : k === "MM" ? p2(d.getUTCMonth() + 1) : k === "dd" ? p2(d.getUTCDate()) : k === "EEE" ? days[d.getUTCDay()]! : k === "HH" ? p2(d.getUTCHours()) : k === "hh" ? p2(d.getUTCHours() % 12 || 12) : k === "mm" ? p2(d.getUTCMinutes()) : k === "ss" ? p2(d.getUTCSeconds()) : k === "a" ? (d.getUTCHours() < 12 ? "AM" : "PM") : "+0000",
          )
          .replace(/\u0000/g, "");
      },
    };
  })();

  // ---------- outputs ----------

  /**
   * What TradingView's "Export chart data" would hold for this script: each
   * plot, shape and char series under its title, in the order they first ran,
   * values where they're displayed (after `offset`), whatever their colour.
   * Plots with display.none aren't exported. (packages/resin, parity checks.)
   */
  private readonly cols = new Map<string, { title: string; values: (number | null)[]; exported: boolean }>();
  columns(): { title: string; values: (number | null)[] }[] {
    return [...this.cols.values()].filter((c) => c.exported).map(({ title, values }) => ({ title, values }));
  }
  private column(site: string, title: string, display: unknown) {
    let c = this.cols.get(site);
    if (!c) {
      c = { title, values: new Array<number | null>(this.n).fill(null), exported: String(display ?? "") !== "display.none" };
      this.cols.set(site, c);
    }
    return c;
  }
  /** Where a value drawn with `offset` lands, or null off the chart. */
  private shifted(offset: unknown): number | null {
    const k = this.i + Math.round(typeof offset === "number" && Number.isFinite(offset) ? offset : 0);
    return k >= 0 && k < this.n ? k : null;
  }

  plot(site: string, value: unknown, title: unknown, col: unknown, linewidth: unknown, style: unknown, offset?: unknown, display?: unknown) {
    let p = this.plots.get(site);
    if (!p) {
      const st = String(style ?? "");
      p = {
        title: this.uniqueTitle(typeof title === "string" && title ? title : "Plot"),
        values: new Array<number | null>(this.n).fill(null),
        colors: new Array<unknown>(this.n).fill(null),
        width: typeof linewidth === "number" ? linewidth : 1,
        style: /histogram|columns|area/.test(st) ? "bodies" : /stepline/.test(st) ? "step" : /circles|cross/.test(st) ? "dots" : "solid",
        hidden: String(display ?? "") === "display.none",
      };
      this.plots.set(site, p);
    }
    const v = typeof value === "boolean" ? (value ? 1 : 0) : (value as number);
    const k = this.shifted(offset);
    if (k !== null) {
      p.values[k] = isNa(v) || !visible(col) ? null : v;
      p.colors[k] = col;
      this.column(site, p.title, display).values[k] = isNa(v) ? null : v;
    }
    return { plot: site };
  }

  private uniqueTitle(t: string) {
    const taken = new Set([...this.plots.values()].map((p) => p.title));
    if (!taken.has(t)) return t;
    let k = 2;
    while (taken.has(`${t} ${k}`)) k++;
    return `${t} ${k}`;
  }

  shape(site: string, cond: unknown, style: unknown, location: unknown, col: unknown, text: unknown, isChar = false, title?: unknown, offset?: unknown, display?: unknown) {
    const k = this.shifted(offset);
    const col0 = this.column(site, typeof title === "string" && title ? title : isChar ? "Char" : "Shapes", display);
    if (k === null) return;
    // As TradingView exports them: a bool series as 1 or 0 on every bar, a number as itself (na: empty).
    col0.values[k] = typeof cond === "boolean" ? (cond ? 1 : 0) : isNa(cond) ? null : (cond as number);
    if (!truthy(cond)) return;
    if (!visible(col) || String(display ?? "") === "display.none") return;
    const loc = String(location ?? "location.abovebar");
    const tone = toneOf(col) ?? "info";
    const s = String(style ?? "");
    const shape = isChar
      ? "label"
      : /triangleup/.test(s) ? "triangleUp" : /triangledown/.test(s) ? "triangleDown" : /arrowup/.test(s) ? "arrowUp" : /arrowdown/.test(s) ? "arrowDown" : /label/.test(s) ? "label" : /cross|xcross/.test(s) ? "cross" : "circle";
    const b = this.bars[k]!;
    const marker: (typeof this.shapes)[number] = { index: k, shape, tone };
    if (loc.endsWith("abovebar")) {
      if (this.opts.overlay) marker.price = b.high;
      marker.placement = "above";
    } else if (loc.endsWith("belowbar")) {
      if (this.opts.overlay) marker.price = b.low;
      marker.placement = "below";
    } else if (loc.endsWith("absolute") && typeof cond === "number") marker.price = cond;
    const t = typeof text === "string" && text ? text : undefined;
    if (t) marker.text = t;
    this.shapes.push(marker);
  }

  hline(site: string, price: number, title: unknown, col: unknown, linestyle: unknown) {
    if (!this.levels.has(site) && !isNa(price)) {
      this.levels.set(site, { value: price, title: typeof title === "string" ? title : "", tone: toneOf(col) ?? "neutral", style: /solid/.test(String(linestyle ?? "")) ? "solid" : "dashed" });
    }
    return { hline: site, price };
  }

  fill(site: string, a: unknown, b: unknown, col: unknown) {
    let f = this.fillSites.get(site);
    if (!f) {
      f = { from: a, to: b, colors: new Array<unknown>(this.n).fill(null) };
      this.fillSites.set(site, f);
    }
    f.colors[this.i] = col;
  }

  bgcolor(col: unknown, offset?: unknown, display?: unknown) {
    const k = this.shifted(offset);
    if (k === null || !visible(col) || String(display ?? "") === "display.none") return;
    (this.backgrounds ??= new Array<Tone | null>(this.n).fill(null))[k] = toneOf(col);
  }
  barcolor(col: unknown, offset?: unknown, display?: unknown) {
    const k = this.shifted(offset);
    if (k === null || !visible(col) || String(display ?? "") === "display.none") return;
    const tone = toneOf(col);
    (this.tints ??= new Array<number | null>(this.n).fill(null))[k] = tone === "bull" ? 0.8 : tone === "bear" ? -0.8 : null;
  }
  /** \`plotarrow(series)\`: an up arrow below bars where it's positive, a down arrow above where negative. */
  plotarrow(site: string, v: unknown, title?: unknown, colUp?: unknown, colDown?: unknown, offset?: unknown, display?: unknown) {
    const k = this.shifted(offset);
    const col0 = this.column(site, typeof title === "string" && title ? title : "Arrows", display);
    if (k === null) return;
    col0.values[k] = typeof v === "number" && !isNa(v) ? v : null;
    if (typeof v !== "number" || isNa(v) || v === 0 || String(display ?? "") === "display.none") return;
    const up = v > 0;
    const b = this.bars[k]!;
    this.shapes.push({ index: k, shape: up ? "arrowUp" : "arrowDown", tone: toneOf(up ? colUp : colDown) ?? (up ? "bull" : "bear"), placement: up ? "below" : "above", ...(this.opts.overlay ? { price: up ? b.low : b.high } : {}) });
  }

  /** `alertcondition(cond, title, message)`: each bar where it holds is an event the Terminal can measure. */
  alert(site: string, cond: unknown, title: unknown, message?: unknown) {
    if (!truthy(cond)) return;
    const label = (typeof title === "string" && title) || (typeof message === "string" && message) || "Alert";
    const words = `${label} ${typeof message === "string" ? message : ""}`.toLowerCase();
    const tone: Tone = /\b(buy|long|bull|bullish|up|above|breakout|oversold)\b/.test(words) ? "bull" : /\b(sell|short|bear|bearish|down|below|breakdown|overbought)\b/.test(words) ? "bear" : "neutral";
    const code = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || site;
    this.events.push({ index: this.i, code, label, tone });
  }

  // ---------- drawings: label, line, box, table ----------

  /**
   * Keep a new drawing, deleting the oldest past the script's maximum as Pine
   * does. Each drawing carries its kind (not a field) so methods find it
   * without searching the lists, and a list sheds its deleted drawings as it
   * grows: scripts that draw on every bar stay linear.
   */
  private keep(list: Drawn[], obj: Drawn, max: number) {
    const kind = list === this.labels ? "label" : list === this.lines ? "line" : list === this.boxes ? "box" : list === this.polylines ? "polyline" : list === this.linefills ? "linefill" : "table";
    Object.defineProperty(obj, "__kind", { value: kind, configurable: true });
    list.push(obj);
    let alive = 0;
    let oldest = -1;
    for (let k = list.length - 1; k >= 0; k--) {
      if (list[k]!.deleted) continue;
      alive++;
      oldest = k;
      if (alive > max) break;
    }
    if (alive > max) list[oldest]!.deleted = true;
    if (list.length > 4 * max + 64) {
      const kept = list.filter((o) => !o.deleted);
      list.length = 0;
      list.push(...kept);
    }
    return obj;
  }
  /** A bar index from an x that may be a time (`xloc.bar_time`). */
  private xIndex(x: unknown, xloc: unknown): number {
    const v = x as number;
    if (String(xloc ?? "") === "xloc.bar_time") {
      const exact = this.times.get(v);
      if (exact !== undefined) return exact;
      const first = this.bars[0]?.time ?? 0;
      return Math.round((v - first) / this.opts.periodMs);
    }
    return v;
  }

  readonly label = (() => {
    const self = this;
    const set = (key: string) => (o: Drawn | undefined, v: unknown) => {
      if (o && !isNa(o)) o[key] = v;
    };
    return {
      /** `label.all`: every label still drawn, oldest first. */
      get all() {
        return self.labels.filter((o) => !o.deleted);
      },
      new: (...a: unknown[]): Drawn => {
        // label.new(point, text, xloc, …) or label.new(x, y, text, xloc, …).
        if (isPoint(a[0])) return self.label.new(self.px(a[0], a[2]), a[0].price, ...a.slice(1));
        const [x, y, text = "", xloc = "xloc.bar_index", yloc = "yloc.price", col = NaN, style = "label.style_label_down"] = a;
        return self.keep(self.labels, { deleted: false, x: self.xIndex(x, xloc), y, text, yloc, color: col, style, xloc }, self.opts.maxLabels ?? 50);
      },
      set_point: (o: Drawn | undefined, p: ChartPoint) => {
        if (o && typeof o === "object" && isPoint(p)) {
          o.x = self.xIndex(self.px(p, o.xloc), o.xloc);
          o.y = p.price;
        }
      },
      delete: (o: Drawn | undefined) => {
        if (o && typeof o === "object") o.deleted = true;
      },
      set_x: (o: Drawn | undefined, x: unknown) => { if (o && !isNa(o)) o.x = self.xIndex(x, o.xloc); },
      set_y: set("y"),
      set_xy: (o: Drawn | undefined, x: unknown, y: unknown) => {
        if (o && !isNa(o)) {
          o.x = self.xIndex(x, o.xloc);
          o.y = y;
        }
      },
      set_text: set("text"),
      set_color: set("color"),
      set_style: set("style"),
      set_textcolor: () => undefined,
      set_size: () => undefined,
      set_tooltip: () => undefined,
      get_x: (o: Drawn) => o?.x ?? NaN,
      get_y: (o: Drawn) => o?.y ?? NaN,
      get_text: (o: Drawn) => o?.text ?? "",
      copy: (o: Drawn) => self.keep(self.labels, { ...o }, self.opts.maxLabels ?? 50),
    };
  })();

  readonly line = (() => {
    const self = this;
    const set = (key: string) => (o: Drawn | undefined, v: unknown) => {
      if (o && !isNa(o)) o[key] = v;
    };
    return {
      /** `line.all`: every line still drawn, oldest first. */
      get all() {
        return self.lines.filter((o) => !o.deleted);
      },
      new: (...a: unknown[]): Drawn => {
        // line.new(first_point, second_point, xloc, …) or line.new(x1, y1, x2, y2, xloc, …).
        if (isPoint(a[0]) && isPoint(a[1])) return self.line.new(self.px(a[0], a[2]), a[0].price, self.px(a[1], a[2]), a[1].price, ...a.slice(2));
        const [x1, y1, x2, y2, xloc = "xloc.bar_index", extend = "extend.none", col = NaN, style = "line.style_solid", width = 1] = a;
        return self.keep(self.lines, { deleted: false, x1: self.xIndex(x1, xloc), y1, x2: self.xIndex(x2, xloc), y2, xloc, extend, color: col, style, width }, self.opts.maxLines ?? 50);
      },
      set_first_point: (o: Drawn | undefined, p: ChartPoint) => {
        if (o && typeof o === "object" && isPoint(p)) [o.x1, o.y1] = [self.xIndex(self.px(p, o.xloc), o.xloc), p.price];
      },
      set_second_point: (o: Drawn | undefined, p: ChartPoint) => {
        if (o && typeof o === "object" && isPoint(p)) [o.x2, o.y2] = [self.xIndex(self.px(p, o.xloc), o.xloc), p.price];
      },
      delete: (o: Drawn | undefined) => {
        if (o && typeof o === "object") o.deleted = true;
      },
      set_x1: (o: Drawn | undefined, x: unknown) => { if (o && !isNa(o)) o.x1 = self.xIndex(x, o.xloc); },
      set_x2: (o: Drawn | undefined, x: unknown) => { if (o && !isNa(o)) o.x2 = self.xIndex(x, o.xloc); },
      set_y1: set("y1"),
      set_y2: set("y2"),
      set_xy1: (o: Drawn | undefined, x: unknown, y: unknown) => { if (o && !isNa(o)) { o.x1 = self.xIndex(x, o.xloc); o.y1 = y; } },
      set_xy2: (o: Drawn | undefined, x: unknown, y: unknown) => { if (o && !isNa(o)) { o.x2 = self.xIndex(x, o.xloc); o.y2 = y; } },
      set_color: set("color"),
      set_style: set("style"),
      set_width: set("width"),
      set_extend: set("extend"),
      get_x1: (o: Drawn) => o?.x1 ?? NaN,
      get_x2: (o: Drawn) => o?.x2 ?? NaN,
      get_y1: (o: Drawn) => o?.y1 ?? NaN,
      get_y2: (o: Drawn) => o?.y2 ?? NaN,
      get_price: (o: Drawn, x: number) => {
        const x1 = o.x1 as number, x2 = o.x2 as number, y1 = o.y1 as number, y2 = o.y2 as number;
        return x1 === x2 ? y1 : y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
      },
      copy: (o: Drawn) => self.keep(self.lines, { ...o }, self.opts.maxLines ?? 50),
    };
  })();

  private readonly polylines: Drawn[] = [];
  /** \`polyline.*\`: drawn as the segments between its points (closed back to the first when asked). */
  readonly polyline = (() => {
    const self = this;
    return {
      /** `polyline.all`: every polyline still drawn, oldest first. */
      get all() {
        return self.polylines.filter((o) => !o.deleted);
      },
      new: (points: unknown, _curved: unknown = false, closed: unknown = false, xloc: unknown = "xloc.bar_index", col: unknown = NaN, _fill: unknown = NaN, style: unknown = "line.style_solid", width: unknown = 1): Drawn => {
        const pts = (Array.isArray(points) ? points : []).filter(isPoint).map((p) => ({ x: self.xIndex(self.px(p, xloc), xloc), y: p.price }));
        return self.keep(self.polylines, { deleted: false, pts, closed: truthy(closed), color: col, style, width }, 100);
      },
      delete: (o: Drawn | undefined) => {
        if (o && typeof o === "object") o.deleted = true;
      },
    };
  })();

  private readonly linefills: Drawn[] = [];
  /** \`linefill.*\`: the space between two lines, drawn as a zone when both are level. */
  readonly linefill = (() => {
    const self = this;
    return {
      /** `linefill.all`: every linefill still drawn, oldest first. */
      get all() {
        return self.linefills.filter((o) => !o.deleted);
      },
      new: (l1: Drawn, l2: Drawn, col: unknown = NaN): Drawn => self.keep(self.linefills, { deleted: false, l1, l2, color: col }, 100),
      delete: (o: Drawn | undefined) => {
        if (o && typeof o === "object") o.deleted = true;
      },
      set_color: (o: Drawn | undefined, col: unknown) => {
        if (o && typeof o === "object") o.color = col;
      },
      get_line1: (o: Drawn) => o?.l1 ?? NaN,
      get_line2: (o: Drawn) => o?.l2 ?? NaN,
    };
  })();

  readonly box = (() => {
    const self = this;
    const set = (key: string) => (o: Drawn | undefined, v: unknown) => {
      if (o && !isNa(o)) o[key] = v;
    };
    return {
      /** `box.all`: every box still drawn, oldest first. */
      get all() {
        return self.boxes.filter((o) => !o.deleted);
      },
      new: (...a: unknown[]): Drawn => {
        // box.new(top_left, bottom_right, border_color, …) or box.new(left, top, right, bottom, border_color, …).
        if (isPoint(a[0]) && isPoint(a[1])) return self.box.new(self.px(a[0], a[6]), a[0].price, self.px(a[1], a[6]), a[1].price, ...a.slice(2));
        const [left, top, right, bottom, borderColor = NaN, , , extend = "extend.none", xloc = "xloc.bar_index", bgcolor = NaN, text = ""] = a;
        return self.keep(self.boxes, { deleted: false, left: self.xIndex(left, xloc), top, right: self.xIndex(right, xloc), bottom, xloc, extend, color: isNa(bgcolor) ? borderColor : bgcolor, text }, self.opts.maxBoxes ?? 50);
      },
      set_top_left_point: (o: Drawn | undefined, p: ChartPoint) => {
        if (o && typeof o === "object" && isPoint(p)) [o.left, o.top] = [self.xIndex(self.px(p, o.xloc), o.xloc), p.price];
      },
      set_bottom_right_point: (o: Drawn | undefined, p: ChartPoint) => {
        if (o && typeof o === "object" && isPoint(p)) [o.right, o.bottom] = [self.xIndex(self.px(p, o.xloc), o.xloc), p.price];
      },
      delete: (o: Drawn | undefined) => {
        if (o && typeof o === "object") o.deleted = true;
      },
      set_left: (o: Drawn | undefined, x: unknown) => { if (o && !isNa(o)) o.left = self.xIndex(x, o.xloc); },
      set_right: (o: Drawn | undefined, x: unknown) => { if (o && !isNa(o)) o.right = self.xIndex(x, o.xloc); },
      set_top: set("top"),
      set_bottom: set("bottom"),
      set_lefttop: (o: Drawn | undefined, x: unknown, y: unknown) => { if (o && !isNa(o)) { o.left = self.xIndex(x, o.xloc); o.top = y; } },
      set_rightbottom: (o: Drawn | undefined, x: unknown, y: unknown) => { if (o && !isNa(o)) { o.right = self.xIndex(x, o.xloc); o.bottom = y; } },
      set_bgcolor: set("color"),
      set_border_color: () => undefined,
      set_text: set("text"),
      set_extend: set("extend"),
      get_left: (o: Drawn) => o?.left ?? NaN,
      get_right: (o: Drawn) => o?.right ?? NaN,
      get_top: (o: Drawn) => o?.top ?? NaN,
      get_bottom: (o: Drawn) => o?.bottom ?? NaN,
      copy: (o: Drawn) => self.keep(self.boxes, { ...o }, self.opts.maxBoxes ?? 50),
    };
  })();

  readonly table = (() => {
    const self = this;
    return {
      /** `table.all`: every table still drawn, oldest first. */
      get all() {
        return self.tables.filter((o) => !o.deleted);
      },
      // Where it sits and how it's framed are TradingView's on-chart presentation: the Terminal shows tables in the indicator's window.
      new: () => {
        const t: Drawn = { deleted: false, cells: new Map<string, Cell>(), merges: [] as { c0: number; r0: number; c1: number; r1: number }[] };
        Object.defineProperty(t, "__kind", { value: "table" });
        self.tables.push(t);
        return t;
      },
      cell: (t: Drawn | undefined, column: number, row: number, text: unknown = "", _w?: unknown, _h?: unknown, textColor: unknown = NaN, _ha?: unknown, _va?: unknown, _size?: unknown, bgcolor: unknown = NaN) => {
        if (!t || typeof t !== "object") return;
        (t.cells as Map<string, Cell>).set(`${row}|${column}`, { col: column, row, text: String(text ?? ""), textColor, bgcolor });
      },
      cell_set_text: (t: Drawn | undefined, column: number, row: number, text: unknown) => {
        const c = cellOf(t, column, row);
        if (c) c.text = String(text ?? "");
      },
      cell_set_bgcolor: (t: Drawn | undefined, column: number, row: number, col: unknown) => {
        const c = cellOf(t, column, row);
        if (c) c.bgcolor = col;
      },
      cell_set_text_color: (t: Drawn | undefined, column: number, row: number, col: unknown) => {
        const c = cellOf(t, column, row);
        if (c) c.textColor = col;
      },
      merge_cells: (t: Drawn | undefined, c0: number, r0: number, c1: number, r1: number) => {
        if (t && typeof t === "object") (t.merges as unknown[]).push({ c0, r0, c1, r1 });
      },
      clear: (t: Drawn | undefined, c0 = 0, r0 = 0, c1?: number, r1?: number) => {
        const cells = t && typeof t === "object" ? (t.cells as Map<string, Cell>) : undefined;
        if (!cells) return;
        for (const [k, c] of cells) if (c.col >= c0 && c.row >= r0 && (c1 === undefined || c.col <= c1) && (r1 === undefined || c.row <= r1)) cells.delete(k);
      },
      delete: (t: Drawn | undefined) => {
        if (t && typeof t === "object") t.deleted = true;
      },
    };
  })();

  // ---------- arrays, maps and methods on objects ----------

  readonly array = {
    new: <T>(size = 0, init: T | number = NaN) => Array.from({ length: Math.max(0, Math.round(nz(size) as number)) }, () => init),
    from: <T>(...xs: T[]) => [...xs],
    size: (a: unknown[]) => a.length,
    get: (a: unknown[], k: number) => (k < 0 ? a[a.length + k] : a[k]) ?? NaN,
    set: (a: unknown[], k: number, v: unknown) => {
      a[k < 0 ? a.length + k : k] = v;
    },
    push: (a: unknown[], v: unknown) => {
      a.push(v);
    },
    unshift: (a: unknown[], v: unknown) => {
      a.unshift(v);
    },
    pop: (a: unknown[]) => a.pop() ?? NaN,
    shift: (a: unknown[]) => a.shift() ?? NaN,
    insert: (a: unknown[], k: number, v: unknown) => {
      a.splice(k, 0, v);
    },
    remove: (a: unknown[], k: number) => a.splice(k, 1)[0] ?? NaN,
    clear: (a: unknown[]) => {
      a.length = 0;
    },
    includes: (a: unknown[], v: unknown) => a.includes(v),
    indexof: (a: unknown[], v: unknown) => a.indexOf(v),
    lastindexof: (a: unknown[], v: unknown) => a.lastIndexOf(v),
    first: (a: unknown[]) => a[0] ?? NaN,
    last: (a: unknown[]) => a[a.length - 1] ?? NaN,
    sum: (a: number[]) => a.reduce((s, x) => s + x, 0),
    avg: (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN),
    max: (a: number[]) => (a.length ? Math.max(...a) : NaN),
    min: (a: number[]) => (a.length ? Math.min(...a) : NaN),
    median: (a: number[]) => (a.length ? last(vec.median(a, a.length)) : NaN),
    stdev: (a: number[], biased = true) => (a.length ? last(vec.stdev(a, a.length, biased)) : NaN),
    range: (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : NaN),
    sort: (a: number[], order: unknown = "order.ascending") => {
      a.sort((x, y) => (String(order).endsWith("descending") ? y - x : x - y));
    },
    reverse: (a: unknown[]) => {
      a.reverse();
    },
    slice: (a: unknown[], from: number, to?: number) => a.slice(from, to),
    copy: (a: unknown[]) => [...a],
    concat: (a: unknown[], b: unknown[]) => {
      a.push(...b);
      return a;
    },
    fill: (a: unknown[], v: unknown, from = 0, to?: number) => {
      a.fill(v, from, to);
    },
    join: (a: unknown[], sep = "") => a.join(sep),
    abs: (a: number[]) => a.map((x) => Math.abs(x)),
    every: (a: unknown[]) => a.every((x) => truthy(x)),
    some: (a: unknown[]) => a.some((x) => truthy(x)),
    mode: (a: number[]) => modeOf(a),
    variance: (a: number[], biased = true) => varianceOf(a, biased),
    covariance: (a: number[], b: number[], biased = true) => {
      const n = Math.min(a.length, b.length);
      if (n === 0) return NaN;
      const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
      const mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
      let c = 0;
      for (let k = 0; k < n; k++) c += (a[k]! - ma) * (b[k]! - mb);
      return c / (biased ? n : n - 1);
    },
    standardize: (a: number[]) => {
      const mean = a.reduce((s, x) => s + x, 0) / a.length;
      const sd = Math.sqrt(varianceOf(a, true));
      return a.map((x) => (x - mean) / sd);
    },
    percentile_linear_interpolation: (a: number[], p: number) => percentileLinear(a, p),
    percentile_nearest_rank: (a: number[], p: number) => percentileNearest(a, p),
    percentrank: (a: number[], k: number) => {
      const v = a[k];
      if (v === undefined || a.length < 2) return NaN;
      return ((a.filter((x) => x <= v).length - 1) / (a.length - 1)) * 100;
    },
    sort_indices: (a: unknown[], order: unknown = "order.ascending") => {
      const desc = String(order).endsWith("descending");
      const cmp = (x: unknown, y: unknown) => (typeof x === "string" ? String(x).localeCompare(String(y)) : (x as number) - (y as number));
      return a.map((_, k) => k).sort((i, j) => (desc ? cmp(a[j], a[i]) : cmp(a[i], a[j])));
    },
    binary_search: (a: number[], v: number) => {
      let [lo, hi] = [0, a.length - 1];
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] === v) return mid;
        if (a[mid]! < v) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    },
    /** The value's index, or else the index of the nearest smaller element (-1 when none). */
    binary_search_leftmost: (a: number[], v: number) => {
      let [lo, hi] = [0, a.length];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid]! < v) lo = mid + 1;
        else hi = mid;
      }
      return a[lo] === v ? lo : lo - 1;
    },
    /** The value's index, or else the index of the nearest larger element. */
    binary_search_rightmost: (a: number[], v: number) => {
      let [lo, hi] = [0, a.length];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid]! <= v) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 && a[lo - 1] === v ? lo - 1 : lo;
    },
  };

  readonly map = {
    new: () => new Map<unknown, unknown>(),
    put: (m: Map<unknown, unknown>, k: unknown, v: unknown) => {
      const prev = m.get(k);
      m.set(k, v);
      return prev ?? NaN;
    },
    get: (m: Map<unknown, unknown>, k: unknown) => m.get(k) ?? NaN,
    contains: (m: Map<unknown, unknown>, k: unknown) => m.has(k),
    remove: (m: Map<unknown, unknown>, k: unknown) => {
      const prev = m.get(k);
      m.delete(k);
      return prev ?? NaN;
    },
    size: (m: Map<unknown, unknown>) => m.size,
    keys: (m: Map<unknown, unknown>) => [...m.keys()],
    values: (m: Map<unknown, unknown>) => [...m.values()],
    clear: (m: Map<unknown, unknown>) => m.clear(),
    copy: (m: Map<unknown, unknown>) => new Map(m),
    put_all: (m: Map<unknown, unknown>, from: Map<unknown, unknown>) => {
      for (const [k, v] of from) m.set(k, v);
    },
  };

  /** \`chart.point.*\`: a time, bar index and price. */
  readonly point = (() => {
    const self = this;
    return {
      new: (time: number, index: number, price: number): ChartPoint => ({ time, index, price }),
      from_index: (index: number, price: number): ChartPoint => ({ time: self.bars[index]?.time ?? NaN, index, price }),
      from_time: (time: number, price: number): ChartPoint => ({ time, index: self.xIndex(time, "xloc.bar_time"), price }),
      now: (price: number = self.close): ChartPoint => ({ time: self.time, index: self.i, price }),
      copy: (p: ChartPoint): ChartPoint => ({ ...p }),
    };
  })();

  /** A point's x on a drawing's axis. */
  private px(p: ChartPoint, xloc: unknown) {
    return String(xloc ?? "") === "xloc.bar_time" ? p.time : p.index;
  }

  /** Pine matrices: rows of cells; `matrix.*` and their methods. */
  readonly matrix = (() => {
    const self = this;
    const at = (m: PineMatrix, r: number) => m.cells[r < 0 ? m.cells.length + r : r];
    const fn = {
      new: (rows = 0, columns = 0, init: unknown = NaN) => new PineMatrix(Array.from({ length: Math.max(0, rows) }, () => Array.from({ length: Math.max(0, columns) }, () => init)), Math.max(0, columns)),
      get: (m: PineMatrix, r: number, c: number) => at(m, r)?.[c] ?? NaN,
      set: (m: PineMatrix, r: number, c: number, v: unknown) => {
        const row = at(m, r);
        if (!row || c < 0 || c >= m.cols) throw new Error(`matrix.set: (${r}, ${c}) is outside a ${m.cells.length}×${m.cols} matrix`);
        row[c] = v;
      },
      rows: (m: PineMatrix) => m.cells.length,
      columns: (m: PineMatrix) => m.cols,
      elements_count: (m: PineMatrix) => m.cells.length * m.cols,
      add_row: (m: PineMatrix, r?: number, values?: unknown[]) => {
        // A matrix without columns takes them from its first row.
        if (m.cols === 0 && values) {
          m.cols = values.length;
          m.cells = m.cells.map(() => Array.from({ length: m.cols }, () => NaN));
        }
        const row = values ? [...values] : Array.from({ length: m.cols }, () => NaN);
        if (row.length !== m.cols) throw new Error(`matrix.add_row: the row has ${row.length} values, the matrix ${m.cols} columns`);
        m.cells.splice(r === undefined || isNa(r) ? m.cells.length : r, 0, row);
      },
      add_col: (m: PineMatrix, c?: number, values?: unknown[]) => {
        if (m.cells.length === 0 && values) m.cells = values.map(() => []);
        const k = c === undefined || isNa(c) ? m.cols : c;
        m.cells.forEach((row, r) => row.splice(k, 0, values ? values[r] : NaN));
        m.cols++;
      },
      remove_row: (m: PineMatrix, r?: number) => m.cells.splice(r === undefined || isNa(r) ? m.cells.length - 1 : r, 1)[0] ?? [],
      remove_col: (m: PineMatrix, c?: number) => {
        const k = c === undefined || isNa(c) ? m.cols - 1 : c;
        m.cols = Math.max(0, m.cols - 1);
        return m.cells.map((row) => row.splice(k, 1)[0]);
      },
      row: (m: PineMatrix, r: number) => [...(at(m, r) ?? [])],
      col: (m: PineMatrix, c: number) => m.cells.map((row) => row[c]),
      fill: (m: PineMatrix, v: unknown, fromRow = 0, toRow = m.cells.length, fromCol = 0, toCol = m.cols) => {
        for (let r = fromRow; r < toRow; r++) for (let c = fromCol; c < toCol; c++) if (m.cells[r]) m.cells[r]![c] = v;
      },
      copy: (m: PineMatrix) => new PineMatrix(m.cells.map((row) => [...row]), m.cols),
      reverse: (m: PineMatrix) => {
        m.cells.reverse();
        m.cells.forEach((row) => row.reverse());
      },
      swap_rows: (m: PineMatrix, a: number, b: number) => {
        [m.cells[a], m.cells[b]] = [m.cells[b]!, m.cells[a]!];
      },
      swap_columns: (m: PineMatrix, a: number, b: number) => m.cells.forEach((row) => ([row[a], row[b]] = [row[b], row[a]])),
      transpose: (m: PineMatrix) => new PineMatrix(Array.from({ length: m.cols }, (_, c) => m.cells.map((row) => row[c])), m.cells.length),
      sum: (a: PineMatrix, b: PineMatrix | number) => self.matrix.map2(a, b, (x, y) => x + y),
      diff: (a: PineMatrix, b: PineMatrix | number) => self.matrix.map2(a, b, (x, y) => x - y),
      mult: (a: PineMatrix, b: PineMatrix | number | number[]) => {
        if (typeof b === "number") return self.matrix.map2(a, b, (x, y) => x * y);
        if (Array.isArray(b)) return a.cells.map((row) => row.reduce((s: number, x, k) => s + (x as number) * (b[k] as number), 0));
        if (a.cols !== b.cells.length) throw new Error("matrix.mult: the shapes don't fit");
        return new PineMatrix(a.cells.map((row) => Array.from({ length: b.cols }, (_, c) => row.reduce((s: number, x, k) => s + (x as number) * (b.cells[k]![c] as number), 0))), b.cols);
      },
      avg: (m: PineMatrix) => { const v = m.cells.flat() as number[]; return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; },
      max: (m: PineMatrix) => { const v = m.cells.flat() as number[]; return v.length ? Math.max(...v) : NaN; },
      min: (m: PineMatrix) => { const v = m.cells.flat() as number[]; return v.length ? Math.min(...v) : NaN; },
      trace: (m: PineMatrix) => m.cells.reduce((s: number, row, k) => s + ((row[k] as number) ?? 0), 0),
      is_square: (m: PineMatrix) => m.cells.length === m.cols,
      concat: (a: PineMatrix, b: PineMatrix) => {
        a.cells.push(...b.cells.map((row) => [...row]));
        return a;
      },
      reshape: (m: PineMatrix, rows: number, cols: number) => {
        const flat = m.cells.flat();
        m.cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => flat[r * cols + c] ?? NaN));
        m.cols = cols;
      },
      submatrix: (m: PineMatrix, fromRow = 0, toRow = m.cells.length, fromCol = 0, toCol = m.cols) =>
        new PineMatrix(m.cells.slice(fromRow, toRow).map((row) => row.slice(fromCol, toCol)), Math.max(0, toCol - fromCol)),
      sort: (m: PineMatrix, column = 0, order: unknown = "order.ascending") => {
        const desc = String(order).endsWith("descending");
        m.cells.sort((x, y) => (desc ? (y[column] as number) - (x[column] as number) : (x[column] as number) - (y[column] as number)));
      },
      median: (m: PineMatrix) => { const v = (m.cells.flat() as number[]).filter((x) => !isNa(x)); return v.length ? last(vec.median(v, v.length)) : NaN; },
      mode: (m: PineMatrix) => modeOf(m.cells.flat() as number[]),
      det: (m: PineMatrix) => {
        const a = m.cells.map((row) => [...(row as number[])]);
        const n = a.length;
        let det = 1;
        for (let c = 0; c < n; c++) {
          let p = c;
          for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
          if (a[p]![c] === 0) return 0;
          if (p !== c) [a[p], a[c], det] = [a[c]!, a[p]!, -det];
          det *= a[c]![c]!;
          for (let r = c + 1; r < n; r++) {
            const f = a[r]![c]! / a[c]![c]!;
            for (let k = c; k < n; k++) a[r]![k]! -= f * a[c]![k]!;
          }
        }
        return det;
      },
      /** Gauss–Jordan inverse; na cells when singular. */
      inv: (m: PineMatrix) => {
        const n = m.cells.length;
        const a = m.cells.map((row, r) => [...(row as number[]), ...Array.from({ length: n }, (_, k) => (k === r ? 1 : 0))]);
        for (let c = 0; c < n; c++) {
          let p = c;
          for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
          if (!a[p]![c]) return new PineMatrix(Array.from({ length: n }, () => Array.from({ length: n }, () => NaN)), n);
          [a[p], a[c]] = [a[c]!, a[p]!];
          const d = a[c]![c]!;
          for (let k = 0; k < 2 * n; k++) a[c]![k]! /= d;
          for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = a[r]![c]!;
            for (let k = 0; k < 2 * n; k++) a[r]![k]! -= f * a[c]![k]!;
          }
        }
        return new PineMatrix(a.map((row) => row.slice(n)), n);
      },
      pow: (m: PineMatrix, power: number) => {
        let out = new PineMatrix(m.cells.map((_, r) => m.cells.map((__, c) => (r === c ? 1 : 0))), m.cols);
        for (let k = 0; k < power; k++) out = self.matrix.mult(out, m) as PineMatrix;
        return out;
      },
      rank: (m: PineMatrix) => {
        const a = m.cells.map((row) => [...(row as number[])]);
        let rank = 0;
        for (let c = 0; c < m.cols && rank < a.length; c++) {
          let p = rank;
          for (let r = rank + 1; r < a.length; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
          if (Math.abs(a[p]![c]!) < 1e-12) continue;
          [a[p], a[rank]] = [a[rank]!, a[p]!];
          for (let r = rank + 1; r < a.length; r++) {
            const f = a[r]![c]! / a[rank]![c]!;
            for (let k = c; k < m.cols; k++) a[r]![k]! -= f * a[rank]![k]!;
          }
          rank++;
        }
        return rank;
      },
      kron: (a: PineMatrix, b: PineMatrix) =>
        new PineMatrix(
          a.cells.flatMap((ra) => b.cells.map((rb) => ra.flatMap((x) => rb.map((y) => (x as number) * (y as number))))),
          a.cols * b.cols,
        ),
      is_zero: (m: PineMatrix) => m.cells.every((row) => row.every((x) => x === 0)),
      is_binary: (m: PineMatrix) => m.cells.every((row) => row.every((x) => x === 0 || x === 1)),
      is_identity: (m: PineMatrix) => m.cells.length === m.cols && m.cells.every((row, r) => row.every((x, c) => x === (r === c ? 1 : 0))),
      is_diagonal: (m: PineMatrix) => m.cells.length === m.cols && m.cells.every((row, r) => row.every((x, c) => r === c || x === 0)),
      is_antidiagonal: (m: PineMatrix) => m.cells.length === m.cols && m.cells.every((row, r) => row.every((x, c) => r + c === m.cols - 1 || x === 0)),
      is_symmetric: (m: PineMatrix) => m.cells.length === m.cols && m.cells.every((row, r) => row.every((x, c) => x === m.cells[c]![r])),
      is_antisymmetric: (m: PineMatrix) => m.cells.length === m.cols && m.cells.every((row, r) => row.every((x, c) => x === -(m.cells[c]![r] as number))),
      is_triangular: (m: PineMatrix) =>
        m.cells.length === m.cols && (m.cells.every((row, r) => row.every((x, c) => c <= r || x === 0)) || m.cells.every((row, r) => row.every((x, c) => c >= r || x === 0))),
      is_stochastic: (m: PineMatrix) => m.cells.every((row) => Math.abs((row as number[]).reduce((s, x) => s + x, 0) - 1) < 1e-9 && row.every((x) => (x as number) >= 0)),
      map2: (a: PineMatrix, b: PineMatrix | number, f: (x: number, y: number) => number) =>
        new PineMatrix(a.cells.map((row, r) => row.map((x, c) => f(x as number, typeof b === "number" ? b : (b.cells[r]![c] as number)))), a.cols),
    };
    return fn;
  })();

  /** A user-type object's shallow copy, still of its type. */
  copy(obj: unknown): unknown {
    if (!obj || typeof obj !== "object") return obj;
    const type = (obj as { __type?: string }).__type;
    const out = { ...(obj as object) };
    return type ? Object.defineProperty(out, "__type", { value: type }) : out;
  }

  /** A tuple, or as many na values when it came back as na (a branch that didn't run). */
  tuple(v: unknown, n: number): unknown[] {
    return Array.isArray(v) ? v : Array.from({ length: n }, () => NaN);
  }

  /** Whether a value is of a Pine type, as written in a parameter (\`float\`, \`line\`, \`array\`, a user type…). */
  private isType(v: unknown, type: string): boolean {
    switch (type) {
      case "int":
      case "float":
        return typeof v === "number";
      case "bool":
        return typeof v === "boolean";
      case "string":
        return typeof v === "string";
      case "color":
        return typeof v === "string" && v.startsWith("#");
      case "array":
        return Array.isArray(v);
      case "matrix":
        return v instanceof PineMatrix;
      case "map":
        return v instanceof Map;
      case "label":
        return (v as { __kind?: string } | null)?.__kind === "label";
      case "line":
        return (v as { __kind?: string } | null)?.__kind === "line";
      case "box":
        return (v as { __kind?: string } | null)?.__kind === "box";
      case "table":
        return (v as { __kind?: string } | null)?.__kind === "table";
      case "polyline":
        return (v as { __kind?: string } | null)?.__kind === "polyline";
      case "linefill":
        return (v as { __kind?: string } | null)?.__kind === "linefill";
      case "chart.point":
        return isPoint(v);
      default:
        return !!v && typeof v === "object" && (v as { __type?: string }).__type === type;
    }
  }

  /** Whether a value is of any of these types (a script's method applies to it, not a built-in of the same name). */
  isOfAny(v: unknown, types: string[]): boolean {
    return types.some((t) => this.isType(v, t));
  }

  /** Which of a function's overloads fits these arguments: by count, then by the most parameter types matched (na fits any). */
  overload(args: unknown[], sigs: (string | null)[][], required: number[]): number {
    let best = 0;
    let bestScore = -Infinity;
    sigs.forEach((sig, k) => {
      if (args.length > sig.length || args.length < required[k]!) return;
      let score = 0;
      for (let j = 0; j < args.length; j++) {
        const t = sig[j];
        if (!t || isNa(args[j])) continue;
        if (this.isType(args[j], t)) score += 2;
        else score -= 10;
      }
      if (score > bestScore) [best, bestScore] = [k, score];
    });
    return best;
  }

  /** `obj.name(args)` for built-in objects: arrays, maps, labels, lines, boxes, tables, user-type copies. */
  method(obj: unknown, name: string, args: unknown[]): unknown {
    type Fns = Record<string, (...a: unknown[]) => unknown>;
    const ns: Fns | null = typeof obj === "string"
      ? (this.str as unknown as Fns)
      : (obj as { __kind?: string } | null)?.__kind === "polyline"
      ? (this.polyline as unknown as Fns)
      : (obj as { __kind?: string } | null)?.__kind === "linefill"
      ? (this.linefill as unknown as Fns)
      : obj instanceof PineMatrix
      ? (this.matrix as unknown as Fns)
      : Array.isArray(obj)
      ? (this.array as unknown as Fns)
      : obj instanceof Map
        ? (this.map as unknown as Fns)
        : (obj as { __kind?: string } | null)?.__kind === "label"
          ? (this.label as unknown as Fns)
          : (obj as { __kind?: string } | null)?.__kind === "line"
            ? (this.line as unknown as Fns)
            : (obj as { __kind?: string } | null)?.__kind === "box"
              ? (this.box as unknown as Fns)
              : (obj as { __kind?: string } | null)?.__kind === "table"
                ? (this.table as unknown as Fns)
                : null;
    if (ns && typeof ns[name] === "function") return ns[name]!(obj, ...args);
    if (name === "copy" && obj && typeof obj === "object") return this.copy(obj);
    if (isNa(obj)) return NaN;
    throw new Error(`.${name}() isn't available on this value`);
  }

  /** A user-defined type's constructor: fields in order, each with its default. */
  udt(fields: string[], defaults: (() => unknown)[], name = "") {
    return {
      // Tagged with its type (not a field): overloaded functions pick by it.
      new: (values: unknown[]) => Object.defineProperty(Object.fromEntries(fields.map((f, k) => [f, values[k] === undefined ? defaults[k]!() : values[k]])), "__type", { value: name }),
    };
  }

  // ---------- the result ----------

  output() {
    const n = this.n;
    this.strategy.finish();
    const titleOf = (h: unknown): string | number | null => {
      if (h && typeof h === "object" && "plot" in h) return this.plots.get((h as { plot: string }).plot)?.title ?? null;
      if (h && typeof h === "object" && "hline" in h) return (h as unknown as { price: number }).price;
      return null;
    };
    const lines: unknown[] = [];
    const bodies = [...this.bodies];
    const dots: unknown[] = [];
    for (const p of this.plots.values()) {
      if (p.hidden) continue;
      const tones = p.colors.map((c) => toneOf(c));
      const distinct = new Set(tones.filter((t) => t !== null));
      if (p.style === "bodies") {
        p.values.forEach((v, k) => {
          if (v !== null) bodies.push({ index: k, top: Math.max(v, 0), bottom: Math.min(v, 0), tone: tones[k] ?? "info" });
        });
        continue;
      }
      if (p.style === "dots") {
        p.values.forEach((v, k) => {
          if (v !== null) dots.push({ index: k, price: v, shape: "circle", tone: tones[k] ?? "info" });
        });
        continue;
      }
      lines.push({
        title: p.title,
        values: p.values,
        style: p.style,
        width: p.width,
        ...(distinct.size > 1 ? { tones } : { tone: [...distinct][0] ?? "info" }),
      });
    }
    const fills = [...this.fillSites.values()].flatMap((f) => {
      const from = titleOf(f.from);
      const to = titleOf(f.to);
      if (from === null || to === null) return [];
      return [{ from, to, tones: f.colors.map((c) => toneOf(c)) }];
    });
    // A strategy's fills: entries are events the Terminal can measure (on the bar that placed them), and both are marked.
    const fillMarks: unknown[] = [];
    const strategyEvents: { index: number; code: string; label: string; tone: Tone }[] = [];
    for (const f of this.strategy.fills) {
      const long = f.side === 1;
      const below = f.kind === "entry" ? long : !long;
      fillMarks.push({
        index: f.index,
        ...(this.opts.overlay ? { price: f.price } : {}),
        shape: f.kind === "entry" ? (long ? "triangleUp" : "triangleDown") : "cross",
        tone: f.kind === "entry" ? (long ? "bull" : "bear") : "neutral",
        ...(f.id ? { text: f.id.slice(0, 40) } : {}),
        placement: below ? "below" : "above",
      });
      if (f.kind !== "entry") continue;
      const side = long ? "Long" : "Short";
      const label = !f.id || f.id.toLowerCase() === side.toLowerCase() ? `${side} entry` : `${side} entry: ${f.id}`;
      const code = `entry_${side.toLowerCase()}_${f.id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`.replace(/_$/, "").slice(0, 60);
      strategyEvents.push({ index: Math.max(0, f.signal), code, label, tone: long ? "bull" : "bear" });
    }
    const markers = [
      ...this.shapes,
      ...fillMarks,
      ...dots,
      ...this.labels
        .filter((l) => !l.deleted && !isNa(l.y) && String(l.style) !== "label.style_none")
        .map((l) => {
          const style = String(l.style);
          const placement = /label_up|triangleup|arrowup/.test(style) ? "below" : "above";
          return { index: l.x, price: l.y, shape: "label", tone: toneOf(l.color) ?? "info", text: String(l.text ?? ""), placement };
        }),
    ];
    const far = n - 1 + 20;
    const segments = this.lines
      .filter((l) => !l.deleted)
      .map((l) => {
        let x1 = l.x1 as number, y1 = l.y1 as number, x2 = l.x2 as number, y2 = l.y2 as number;
        const ext = String(l.extend);
        const slope = x2 === x1 ? 0 : (y2 - y1) / (x2 - x1);
        if (ext.endsWith("right") || ext.endsWith("both")) [x2, y2] = [far, y1 + slope * (far - x1)];
        if (ext.endsWith("left") || ext.endsWith("both")) [x1, y1] = [0, y1 - slope * x1];
        return { from: x1, to: x2, fromPrice: y1, toPrice: y2, tone: toneOf(l.color) ?? "neutral", style: /dash|dot/.test(String(l.style)) ? "dashed" : "solid", width: l.width };
      });
    for (const pl of this.polylines) {
      if (pl.deleted) continue;
      const pts = pl.pts as { x: number; y: number }[];
      const tone = toneOf(pl.color) ?? "neutral";
      const style = /dash|dot/.test(String(pl.style)) ? "dashed" : "solid";
      const pairs = pts.slice(1).map((p, k) => [pts[k]!, p] as const);
      if (pl.closed && pts.length > 2) pairs.push([pts[pts.length - 1]!, pts[0]!]);
      for (const [a, b] of pairs) segments.push({ from: a.x, to: b.x, fromPrice: a.y, toPrice: b.y, tone, style, width: pl.width });
    }
    const levelZones = this.linefills.flatMap((f) => {
      const [a, b] = [f.l1 as Drawn | undefined, f.l2 as Drawn | undefined];
      if (f.deleted || !a || !b || a.deleted || b.deleted || a.y1 !== a.y2 || b.y1 !== b.y2) return [];
      const ys = [a.y1 as number, b.y1 as number];
      return [{ from: Math.min(a.x1 as number, b.x1 as number), to: Math.max(a.x2 as number, b.x2 as number), top: Math.max(...ys), bottom: Math.min(...ys), tone: toneOf(f.color) ?? "info", label: "" }];
    });
    const zones = this.boxes
      .filter((b) => !b.deleted)
      .map((b) => ({ from: b.left, to: /right|both/.test(String(b.extend)) ? far : b.right, top: b.top, bottom: b.bottom, tone: toneOf(b.color) ?? "info", label: String(b.text ?? "") }))
      .concat(levelZones as never[]);
    // Tables go to the indicator's window: two columns as its readings (label · value), wider ones as a grid.
    const dashboard: unknown[] = [];
    const grids: unknown[] = [];
    for (const table of this.tables) {
      if (table.deleted) continue;
      const cells = [...(table.cells as Map<string, Cell>).values()].filter((c) => c.text.trim() !== "");
      if (cells.length === 0) continue;
      const cols = [...new Set(cells.map((c) => c.col))].sort((a, b) => a - b);
      const rowIds = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b);
      if (cols.length <= 2) {
        for (const r of rowIds) {
          const row = cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
          const [head, ...rest] = row;
          if (!head) continue;
          const last = rest[rest.length - 1];
          dashboard.push(rest.length ? { label: head.text, value: rest.map((c) => c.text).join(" "), tone: (last && cellTone(last)) ?? "neutral" } : { label: head.text, value: "", tone: cellTone(head) ?? "neutral" });
        }
        continue;
      }
      const merges = table.merges as { c0: number; r0: number; c1: number; r1: number }[];
      grids.push({
        rows: rowIds.map((r) =>
          cols.flatMap((c) => {
            // A cell inside a merge (not its first) isn't drawn; the first spans the merged columns.
            if (merges.some((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1 && !(r === m.r0 && c === m.c0))) return [];
            const cell = (table.cells as Map<string, Cell>).get(`${r}|${c}`);
            const m = merges.find((x) => x.r0 === r && x.c0 === c);
            const span = m ? cols.filter((k) => k >= m.c0 && k <= m.c1).length : 1;
            return [{ text: cell?.text ?? "", tone: (cell && cellTone(cell)) ?? "neutral", ...(span > 1 ? { span } : {}) }];
          }),
        ),
      });
    }
    return { lines, fills, levels: [...this.levels.values()], markers, bodies, segments, zones, events: [...this.events, ...strategyEvents].sort((a, b) => a.index - b.index), dashboard, tables: grids, ...(this.backgrounds ? { backgrounds: this.backgrounds } : {}), ...(this.tints ? { candleTint: this.tints } : {}) };
  }
}

let latest: Pine | null = null;
/** The runtime the last `start` made: the sandbox reads its columns after a parity run. */
export const lastRun = () => latest;

/** The runtime for one run of a converted script over these bars. */
export function start(
  ctx: { bars: { time: number; open: number; high: number; low: number; close: number; volume: number | null }[]; periodMs: number; higher?: Record<string, PineBar[]>; mintick?: number; symbol?: string; markets?: Record<string, PineBar[]> },
  opts: Partial<PineOptions> = {},
) {
  const bars = ctx.bars.map((b) => ({ ...b, volume: b.volume ?? NaN }));
  latest = new Pine(bars, { overlay: false, periodMs: ctx.periodMs, ...(ctx.higher ? { higher: ctx.higher } : {}), ...(ctx.mintick ? { mintick: ctx.mintick } : {}), ...(ctx.symbol ? { symbol: ctx.symbol } : {}), ...(ctx.markets ? { markets: ctx.markets } : {}), ...opts });
  return latest;
}
