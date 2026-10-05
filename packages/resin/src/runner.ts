import * as engine from "@alphapine/engine";
import type { Column } from "./parity";

type StrategyReport = engine.pine.StrategyReport;

/**
 * Running a converted script outside a host: on bars read from a CSV file,
 * with its inputs at their defaults or as given. The command line and the
 * playground share this; a host such as the AlphaPine Terminal has its own.
 * Loading the module's code (an ES module as text) is the caller's part,
 * since browsers and Node do it differently.
 */

export interface Bar {
  /** Bar open, UTC milliseconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/** One of a converted script's inputs, as `convert` writes it. */
export interface InputSpec {
  label?: string;
  type: "int" | "float" | "bool" | "select" | string;
  default: number | boolean | string;
  min?: number;
  max?: number;
  options?: string[];
}

export type InputValue = number | boolean | string;

/** A converted script once loaded: what `import()` of its code gives. */
export interface ResinModule {
  default: {
    name: string;
    overlay?: boolean;
    inputs?: Record<string, InputSpec>;
    run(ctx: unknown, sdk: unknown): unknown;
  };
}

export class RunError extends Error {}

// ---------------- bars from CSV ----------------

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
    else if (c === "," || c === ";" || c === "\t") {
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
    // Seconds or milliseconds since 1970.
    return n < 1e11 ? n * 1000 : n;
  }
  // A date without a zone is read as UTC, as exchanges publish.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}( |T)\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  if (Number.isNaN(t)) throw new RunError(`"${s}" isn't a time this reads (use UTC seconds, milliseconds or an ISO date)`);
  return t;
};

export interface BarsFile {
  bars: Bar[];
  /** The usual spacing of the bars, ms. */
  periodMs: number;
  /** The price step the file's prices are written in: 0.01 for two decimals. */
  tick: number;
}

/**
 * OHLCV bars from CSV text: a header with time (or date, datetime,
 * timestamp), open, high, low and close, and volume when there is one, in
 * any case and order. Commas, semicolons or tabs separate the cells. Rows
 * come out oldest first.
 */
export function parseBars(text: string): BarsFile {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new RunError("The file has no rows");
  const header = cells(lines[0]!).map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iTime = find("time", "date", "datetime", "timestamp", "open time", "open_time");
  const [iO, iH, iL, iC] = [find("open", "o"), find("high", "h"), find("low", "l"), find("close", "c")];
  const iV = find("volume", "vol", "v");
  if (iTime < 0 || iO < 0 || iH < 0 || iL < 0 || iC < 0) throw new RunError("The header needs time, open, high, low and close columns (volume is optional)");
  const num = (v: string | undefined) => {
    const s = v?.trim() ?? "";
    if (s === "" || s.toLowerCase() === "nan" || s.toLowerCase() === "null") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const rows = lines.slice(1).map(cells);
  const bars = rows
    .map((r, k) => {
      const [open, high, low, close] = [num(r[iO]), num(r[iH]), num(r[iL]), num(r[iC])];
      if (open === null || high === null || low === null || close === null) throw new RunError(`Row ${k + 2} is missing a price`);
      return { time: parseTime(r[iTime] ?? ""), open, high, low, close, volume: iV >= 0 ? num(r[iV]) : null };
    })
    .sort((a, b) => a.time - b.time);
  const gaps = bars.slice(1).map((b, k) => b.time - bars[k]!.time).filter((g) => g > 0).sort((a, b) => a - b);
  const periodMs = gaps[gaps.length >> 1] ?? 60_000;
  let decimals = 0;
  for (const r of rows.slice(0, 2000)) for (const k of [iO, iH, iL, iC]) decimals = Math.max(decimals, /\.(\d+)$/.exec((r[k] ?? "").trim())?.[1]?.length ?? 0);
  const d = Math.min(decimals, 10);
  return { bars, periodMs, tick: Number((10 ** -d).toFixed(d)) };
}

// ---------------- inputs ----------------

/** Every input at its default. */
export function inputDefaults(mod: ResinModule): Record<string, InputValue> {
  return Object.fromEntries(Object.entries(mod.default.inputs ?? {}).map(([k, spec]) => [k, spec.default]));
}

/**
 * The defaults with `given` applied ("length" → "20"), each read as its
 * input's type and checked against its limits and options. An input may be
 * named by its key or its label.
 */
export function resolveInputs(mod: ResinModule, given: Record<string, string> = {}): Record<string, InputValue> {
  const specs = mod.default.inputs ?? {};
  const values = inputDefaults(mod);
  for (const [name, raw] of Object.entries(given)) {
    const key = Object.hasOwn(specs, name) ? name : Object.keys(specs).find((k) => specs[k]!.label === name);
    if (!key) throw new RunError(`"${name}" isn't one of this script's inputs (${Object.keys(specs).join(", ") || "it has none"})`);
    const spec = specs[key]!;
    let v: InputValue;
    if (spec.type === "int" || spec.type === "float") {
      v = Number(raw);
      if (!Number.isFinite(v) || (spec.type === "int" && !Number.isInteger(v))) throw new RunError(`Input "${name}" needs ${spec.type === "int" ? "a whole number" : "a number"}, not "${raw}"`);
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) throw new RunError(`Input "${name}" must be between ${spec.min ?? "−∞"} and ${spec.max ?? "∞"}`);
    } else if (spec.type === "bool") {
      if (!/^(true|false)$/i.test(raw)) throw new RunError(`Input "${name}" is true or false, not "${raw}"`);
      v = raw.toLowerCase() === "true";
    } else {
      v = raw;
      if (spec.options && !spec.options.includes(raw)) throw new RunError(`Input "${name}" is one of: ${spec.options.join(", ")}`);
      // A numeric select keeps its number type.
      if (typeof spec.default === "number") v = Number(raw);
    }
    values[key] = v;
  }
  return values;
}

// ---------------- loading ----------------

/** A converted module's code as a data: URL, UTF-8 safe (licence lines may carry ©). */
export function moduleUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:text/javascript;base64,${btoa(binary)}`;
}

/** Load converted code as a module, in Node or a browser (where the page's CSP allows data: scripts). */
export const loadModule = (code: string): Promise<ResinModule> => import(/* @vite-ignore */ moduleUrl(code));

// ---------------- running ----------------

export interface RunOptions {
  inputs?: Record<string, InputValue>;
  /** Bar period, ms (from the bars when absent). */
  periodMs?: number;
  /** The market's price step (syminfo.mintick). */
  mintick?: number;
  /** The chart's market, e.g. "BTCUSD". */
  symbol?: string;
}

export interface RunResult {
  /** What the script returns to its host: lines, markers, events, tables, drawings. */
  output: unknown;
  /** Every plotted series by title, one value per bar: what a chart export would hold. */
  columns: Column[];
  /** A strategy's results, as a strategy tester lists them; null for an indicator. */
  strategy: StrategyReport | null;
}

/** Run a loaded script over `bars`, oldest first. */
export function runScript(mod: ResinModule, bars: readonly Bar[], opts: RunOptions = {}): RunResult {
  if (bars.length === 0) throw new RunError("There are no bars to run on");
  const gaps = bars.slice(1).map((b, k) => b.time - bars[k]!.time).filter((g) => g > 0).sort((a, b) => a - b);
  const periodMs = opts.periodMs ?? gaps[gaps.length >> 1] ?? 60_000;
  const ctx = {
    bars,
    time: bars.map((b) => b.time),
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume ?? NaN),
    inputs: opts.inputs ?? inputDefaults(mod),
    periodMs,
    ...(opts.mintick ? { mintick: opts.mintick } : {}),
    ...(opts.symbol ? { symbol: opts.symbol } : {}),
  };
  const output = mod.default.run(ctx, { pine: engine.pine, ta: engine.ta });
  const run = engine.pine.lastRun();
  return { output, columns: run?.columns() ?? [], strategy: run?.strategyReport() ?? null };
}

/** The bars and every plotted column as CSV, like a chart export: time in UTC ISO, empty for na. */
export function columnsCsv(bars: readonly Bar[], columns: readonly Column[]): string {
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cell = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "" : String(v));
  const head = ["time", "open", "high", "low", "close", "volume", ...columns.map((c) => quote(c.title))].join(",");
  const rows = bars.map((b, i) => [new Date(b.time).toISOString(), b.open, b.high, b.low, b.close, cell(b.volume), ...columns.map((c) => cell(c.values[i]))].join(","));
  return [head, ...rows].join("\n") + "\n";
}
