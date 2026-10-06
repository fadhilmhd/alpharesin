import * as engine from "@alphapine/engine";
import { describe, expect, it } from "vitest";
import { convert } from "./convert";

/**
 * End to end: a script is converted, the module it becomes is loaded and run
 * on bars with the SDK's Pine runtime, and what it draws is checked against
 * the whole-series engine (itself checked against TradingView).
 */

const vec = engine.ta;

function makeBars(n = 300) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let close = 100;
  return Array.from({ length: n }, (_, i) => {
    const open = close;
    close = Math.max(1, close * (1 + (rnd() - 0.5) * 0.05));
    return { time: i * 3_600_000, open, high: Math.max(open, close) * (1 + rnd() * 0.01), low: Math.min(open, close) * (1 - rnd() * 0.01), close, volume: 500 + rnd() * 500 };
  });
}
const bars = makeBars();
const closes = bars.map((b) => b.close);

type Out = {
  lines: { title: string; values: (number | null)[]; tone?: string; tones?: (string | null)[] }[];
  levels: { value: number; title: string }[];
  fills: { from: string | number; to: string | number }[];
  markers: { index: number; shape: string; tone: string; text?: string; price?: number }[];
  segments: { from: number; to: number; fromPrice: number; toPrice: number }[];
  zones: { from: number; to: number; top: number; bottom: number }[];
  events: { index: number; code: string; label: string; tone: string }[];
  dashboard: { label: string; value: string }[];
};

async function runWith(c: ReturnType<typeof convert>) {
  expect(c.errors, c.code).toEqual([]);
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => Out } };
  return mod.default.run({ bars, periodMs: 3_600_000, inputs: {} }, { pine: engine.pine, ta: engine.ta });
}

async function run(source: string, inputs: Record<string, unknown> = {}) {
  const c = convert(source);
  expect(c.errors, c.code).toEqual([]);
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as {
    default: { name: string; overlay: boolean; inputs: Record<string, { default: unknown }>; run: (ctx: unknown, sdk: unknown) => Out };
  };
  const def = mod.default;
  const resolved = { ...Object.fromEntries(Object.entries(def.inputs).map(([k, s]) => [k, s.default])), ...inputs };
  const out = def.run({ bars, periodMs: 3_600_000, inputs: resolved }, { pine: engine.pine, ta: engine.ta });
  return { def, out, converted: c };
}

const near = (a: (number | null)[], b: number[], name: string) =>
  b.forEach((x, i) => (Number.isNaN(x) ? expect(a[i], `${name} ${i}`).toBeNull() : expect(a[i] as number, `${name} ${i}`).toBeCloseTo(x, 9)));

describe("converted scripts run like the engine", () => {
  it("an RSI with levels, inputs and alert conditions (v6)", async () => {
    const { def, out } = await run(`//@version=6
indicator("RSI signals", overlay = false)
len = input.int(14, "Length", minval = 2, maxval = 100)
lower = input.float(30, "Oversold")
r = ta.rsi(close, len)
plot(r, "RSI", color = color.blue)
hline(70, "Overbought", color = color.red)
hline(lower, "Oversold", color = color.green)
alertcondition(ta.crossover(r, lower), "Long setup", "RSI left oversold")
alertcondition(ta.crossunder(r, 70), "Short setup", "RSI left overbought")`);
    expect(def).toMatchObject({ name: "RSI signals", overlay: false });
    expect(def.inputs).toEqual({ len: { label: "Length", type: "int", default: 14, min: 2, max: 100 }, lower: { label: "Oversold", type: "float", default: 30 } });
    const rsi = vec.rsi(closes, 14);
    near(out.lines[0]!.values, rsi, "rsi");
    expect(out.levels.map((l) => [l.value, l.title])).toEqual([[70, "Overbought"], [30, "Oversold"]]);
    const up = vec.crossover(rsi, new Array(rsi.length).fill(30)).flatMap((x, i) => (x ? [i] : []));
    const down = vec.crossunder(rsi, new Array(rsi.length).fill(70)).flatMap((x, i) => (x ? [i] : []));
    expect(out.events.filter((e) => e.code === "long_setup").map((e) => e.index)).toEqual(up);
    expect(out.events.filter((e) => e.code === "short_setup").map((e) => e.index)).toEqual(down);
    expect(new Set(out.events.map((e) => e.tone))).toEqual(new Set(["bull", "bear"]));
  });

  it("Bollinger bands with a source input, a fill and shapes (v5)", async () => {
    const { def, out } = await run(`//@version=5
indicator("BB", overlay = true)
src = input.source(close, "Source")
length = input.int(20, "Length")
mult = input.float(2.0, "Mult")
[basis, upper, lower] = ta.bb(src, length, mult)
plot(basis, "Basis", color = color.orange)
p1 = plot(upper, "Upper", color = color.teal)
p2 = plot(lower, "Lower", color = color.teal)
fill(p1, p2, color = color.new(color.teal, 90))
plotshape(ta.crossover(close, upper), "Break up", shape.triangleup, location.belowbar, color.green, text = "Up")`, { src: "hl2" });
    expect(def.overlay).toBe(true);
    expect(def.inputs.src).toMatchObject({ type: "select", default: "close" });
    const hl2 = bars.map((b) => (b.high + b.low) / 2);
    const [basis, upper] = vec.bb(hl2, 20, 2);
    near(out.lines[0]!.values, basis, "basis");
    near(out.lines[1]!.values, upper, "upper");
    expect(out.fills).toEqual([expect.objectContaining({ from: "Upper", to: "Lower" })]);
    const breaks = vec.crossover(closes, upper).flatMap((x, i) => (x ? [i] : []));
    expect(out.markers.map((m) => m.index)).toEqual(breaks);
    expect(out.markers.every((m) => m.shape === "triangleUp" && m.text === "Up" && m.tone === "bull")).toBe(true);
  });

  it("gives each call of a user function its own state, and keeps var and history", async () => {
    const { out } = await run(`//@version=6
indicator("State")
smooth(src, len) => ta.ema(src, len)
fast = smooth(close, 10)
slow = smooth(close, 30)
var int ups = 0
if close > close[1]
    ups += 1
streak = 0
streak := close > close[1] ? nz(streak[1]) + 1 : 0
plot(fast, "Fast")
plot(slow, "Slow")
plot(ups, "Ups")
plot(streak, "Streak")`);
    near(out.lines[0]!.values, vec.ema(closes, 10), "fast");
    near(out.lines[1]!.values, vec.ema(closes, 30), "slow");
    let ups = 0;
    let streak = 0;
    bars.forEach((b, i) => {
      if (i > 0 && b.close > bars[i - 1]!.close) ups++;
      streak = i > 0 && b.close > bars[i - 1]!.close ? streak + 1 : 0;
      expect(out.lines[2]!.values[i], `ups ${i}`).toBe(ups);
      expect(out.lines[3]!.values[i], `streak ${i}`).toBe(streak);
    });
  });

  it("runs arrays, loops, switch, if-values, user types and methods", async () => {
    const { out } = await run(`//@version=6
indicator("Language")
type Box
    float lo = na
    float hi = na
method width(Box this) =>
    this.hi - this.lo
enum Mode
    fast = "Fast"
    slow = "Slow"
mode = input.enum(Mode.slow, "Mode")
var float[] window = array.new<float>()
window.push(close)
if window.size() > 5
    window.shift()
total = 0.0
for v in window
    total += v
avg = total / window.size()
b = Box.new(window.min(), window.max())
span = switch mode
    Mode.fast => b.width()
    => b.width() * 2
sign = if close > avg
    1
else
    -1
plot(avg, "Avg")
plot(span, "Span")
plot(sign, "Sign")`);
    const sma5 = closes.map((_, i) => {
      const w = closes.slice(Math.max(0, i - 4), i + 1);
      return w.reduce((s, x) => s + x, 0) / w.length;
    });
    near(out.lines[0]!.values, sma5, "avg");
    const span = closes.map((_, i) => {
      const w = closes.slice(Math.max(0, i - 4), i + 1);
      return (Math.max(...w) - Math.min(...w)) * 2;
    });
    near(out.lines[1]!.values, span, "span");
    expect(out.lines[2]!.values.every((v, i) => v === (closes[i]! > sma5[i]! ? 1 : -1))).toBe(true);
  });

  it("draws labels, lines, boxes and a table from their last state", async () => {
    const { out } = await run(`//@version=6
indicator("Drawings", overlay = true)
var label lbl = na
var line ln = na
if barstate.islast
    lbl := label.new(bar_index, high, "Last", style = label.style_label_down, color = color.red)
    ln := line.new(bar_index - 10, low[10], bar_index, low, color = color.green, style = line.style_dashed)
    box.new(bar_index - 5, high, bar_index, low, bgcolor = color.new(color.blue, 80), text = "Range")
    t = table.new(position.top_right, 2, 2)
    table.cell(t, 0, 0, "Trend")
    table.cell(t, 1, 0, "Up", text_color = color.green)`);
    const n = bars.length;
    expect(out.markers).toEqual([{ index: n - 1, price: bars[n - 1]!.high, shape: "label", tone: "bear", text: "Last", placement: "above" }]);
    expect(out.segments).toEqual([{ from: n - 11, to: n - 1, fromPrice: bars[n - 11]!.low, toPrice: bars[n - 1]!.low, tone: "bull", style: "dashed", width: 1 }]);
    expect(out.zones).toEqual([expect.objectContaining({ from: n - 6, to: n - 1, top: bars[n - 1]!.high, bottom: bars[n - 1]!.low, tone: "info", label: "Range" })]);
    expect(out.dashboard).toEqual([{ label: "Trend", value: "Up", tone: "bull" }]);
  });

  it("lets a function read the script's variables and its var counters", async () => {
    const { out } = await run(`//@version=6
indicator("Globals")
base = input.int(3, "Base")
var int seen = 0
seen += 1
scaled(x) => x * base + seen
plot(scaled(1), "Scaled")`);
    expect(out.lines[0]!.values.slice(0, 3)).toEqual([4, 5, 6]);
  });
});

describe("strategies", () => {
  it("run their orders through the broker: entries become events, and the results match a plain simulation", async () => {
    const { def, out } = await run(`//@version=6
strategy("SMA cross", overlay = true, initial_capital = 10000)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
plot(strategy.position_size, "Position", display = display.data_window)`);
    expect(def).toMatchObject({ name: "SMA cross", overlay: true });
    const report = engine.pine.lastRun()!.strategyReport()!;

    // The same rules by hand: signals on a bar's close fill on the next bar's open, one position at a time.
    const fast = vec.sma(closes, 5);
    const slow = vec.sma(closes, 20);
    const cross = (i: number, up: boolean) => {
      const [a, b, a1, b1] = [fast[i]!, slow[i]!, fast[i - 1]!, slow[i - 1]!];
      if (i < 1 || [a, b, a1, b1].some((x) => x === null || Number.isNaN(x))) return false;
      return up ? a > b && a1 <= b1 : a < b && a1 >= b1;
    };
    const profits: number[] = [];
    const signals: number[] = [];
    let pos = 0;
    let entry = 0;
    let wantIn = false;
    let wantOut = false;
    bars.forEach((b, i) => {
      if (wantOut && pos) (profits.push(b.open - entry), (pos = 0));
      if (wantIn && !pos) (pos = 1), (entry = b.open), signals.push(i - 1);
      wantIn = cross(i, true);
      wantOut = cross(i, false);
    });
    expect(profits.length).toBeGreaterThan(3);
    expect(report.trades).toBe(profits.length);
    expect(report.netProfit).toBeCloseTo(profits.reduce((s, x) => s + x, 0), 8);
    expect(report.openTrades).toBe(pos);
    expect(out.events.map((e) => e.index)).toEqual(signals);
    expect(new Set(out.events.map((e) => `${e.code} ${e.label} ${e.tone}`))).toEqual(new Set(["entry_long_long Long entry bull"]));
  });

  it("read their own state: position, trades and closed-trade fields", async () => {
    await run(`//@version=6
strategy("Flip", overlay = true, pyramiding = 2, default_qty_value = 2)
if bar_index % 10 == 0
    strategy.entry("L", strategy.long)
if bar_index % 10 == 5
    strategy.entry("S", strategy.short, qty = 1)
strategy.exit("Stop", "L", loss = 1000000)
var float lastExit = na
if strategy.closedtrades > 0
    lastExit := strategy.closedtrades.exit_price(strategy.closedtrades - 1)
plot(lastExit, "Last exit")
plot(strategy.position_size, "Size")`);
    const p = engine.pine.lastRun()!;
    const r = p.strategyReport()!;
    const sizes = p.columns().find((c) => c.title === "Size")!.values;
    // Long 2 from bar 1, flipped to short 1 at bar 6 (closing the long), long 2 again at bar 11.
    expect(sizes.slice(0, 12)).toEqual([0, 2, 2, 2, 2, 2, -1, -1, -1, -1, -1, 2]);
    expect(r.list.at(-1)).toMatchObject({ side: "long", entryId: "L", exitId: "S", entryPrice: bars[1]!.open, exitPrice: bars[6]!.open, qty: 2 });
    expect(p.columns().find((c) => c.title === "Last exit")!.values[6]).toBeCloseTo(bars[6]!.open, 9);
  });
});

describe("tables go to the indicator's window", () => {
  it("two columns as readings, wider ones as a grid with merged headers and tones", async () => {
    const { out } = await run(`//@version=6
indicator("Tables", overlay = true)
var small = table.new(position.top_right, 2, 2)
var wide = table.new(position.bottom_left, 3, 3, bgcolor = color.black)
if barstate.islast
    table.cell(small, 0, 0, "Trend")
    table.cell(small, 1, 0, "Up", text_color = color.green)
    wide.cell(0, 0, "Multi-timeframe")
    wide.merge_cells(0, 0, 2, 0)
    for [k, tf] in array.from("1H", "4H", "1D")
        wide.cell(k, 1, tf)
        wide.cell(k, 2, k == 1 ? "Down" : "Up", text_color = k == 1 ? color.red : color.green)
plot(close)`);
    expect(out.dashboard).toEqual([{ label: "Trend", value: "Up", tone: "bull" }]);
    expect((out as { tables?: unknown }).tables).toEqual([
      {
        rows: [
          [{ text: "Multi-timeframe", tone: "neutral", span: 3 }],
          [{ text: "1H", tone: "neutral" }, { text: "4H", tone: "neutral" }, { text: "1D", tone: "neutral" }],
          [{ text: "Up", tone: "bull" }, { text: "Down", tone: "bear" }, { text: "Up", tone: "bull" }],
        ],
      },
    ]);
  });
});

describe("functions as published scripts write them", () => {
  it("picks an overload by its arguments' types, functions and methods alike", async () => {
    const { out } = await run(`//@version=6
indicator("Overloads")
type Pair
    float a
    float b
type Box2
    Pair inner
describe(float x) => x * 2
describe(Pair p) => p.a + p.b
describe(Box2 b) => describe(b.inner) * 10
method size(Pair p) => p.a
method size(Box2 b) => b.inner.size() + 100
p = Pair.new(1, 2)
q = Box2.new(Pair.copy(p))
plot(describe(close), "Float")
plot(describe(p), "Pair")
plot(describe(q), "Box")
plot(q.size(), "Method")`);
    bars.forEach((b, i) => expect(out.lines[0]!.values[i]).toBeCloseTo(b.close * 2, 9));
    expect(new Set(out.lines[1]!.values)).toEqual(new Set([3]));
    expect(new Set(out.lines[2]!.values)).toEqual(new Set([30]));
    expect(new Set(out.lines[3]!.values)).toEqual(new Set([101]));
  });

  it("reads a tuple a branch didn't return as na, and a tuple declared last as the function's value", async () => {
    const { out } = await run(`//@version=6
indicator("Tuples")
f(x) =>
    if x > 1000000
        [x, x]
g() =>
    [a, b] = [1, 2]
[u, v] = f(close)
[c, d] = g()
plot(na(u) ? 0 : 1, "Na")
plot(c + d, "Sum")`);
    expect(new Set(out.lines[0]!.values)).toEqual(new Set([0]));
    expect(new Set(out.lines[1]!.values)).toEqual(new Set([3]));
  });

  it("lets a function declare a variable named like its parameter, from it", async () => {
    const { out } = await run(`//@version=6
indicator("Redeclare")
clean(s) =>
    s = str.replace_all(s, "-", "")
    str.length(s)
plot(clean("a-b-c"), "Len")
plot(00.050 * 100, "Leading zeros")`);
    expect(new Set(out.lines[0]!.values)).toEqual(new Set([3]));
    out.lines[1]!.values.forEach((v) => expect(v).toBeCloseTo(5, 9));
  });
});

describe("colours behind and on the bars", () => {
  it("bgcolor tints the pane's background, barcolor the candles, plotarrow marks the bars", async () => {
    const { out } = await run(`//@version=6
indicator("Colours", overlay = true)
up = close > open
bgcolor(up ? color.new(color.green, 85) : na)
barcolor(up ? color.lime : color.red)
plotarrow(up ? 1 : -1)`);
    const o = out as unknown as { backgrounds: (string | null)[]; candleTint: (number | null)[] };
    bars.forEach((b, i) => {
      const up = b.close > b.open;
      expect(o.backgrounds[i]).toBe(up ? "bull" : null);
      expect(o.candleTint[i]).toBe(up ? 0.8 : -0.8);
    });
    expect(out.markers).toHaveLength(bars.length);
    expect(out.markers[0]).toMatchObject({ shape: bars[0]!.close > bars[0]!.open ? "arrowUp" : "arrowDown" });
  });
});

describe("libraries", () => {
  const LIB = `//@version=6
// @description Helpers.
library("Helpers", overlay = true)
export type Band
    float top
    float bottom
export enum Side
    up = "Up"
    down = "Down"
scale = 2.0
twice(float x) => x * scale
export band(float mid, float width) => Band.new(mid + twice(width), mid - twice(width))
export method height(Band b) => b.top - b.bottom
export side(float x) => x >= 0 ? Side.up : Side.down`;
  const SCRIPT = `//@version=6
import someone/Helpers/2 as h
indicator("Uses a library", overlay = true)
b = h.band(close, 1.5)
h.Band c = h.band(open, 1)
plot(b.top, "Top")
plot(b.height(), "Height")
plot(h.side(close - open) == h.Side.up ? 1 : 0, "Up")`;

  it("read a supplied library's functions, types, enums and methods", async () => {
    const out = await runWith(convert(SCRIPT, { libraries: [{ source: LIB }] }));
    bars.forEach((b, i) => {
      expect(out.lines[0]!.values[i]).toBeCloseTo(b.close + 3, 9);
      expect(out.lines[1]!.values[i]).toBeCloseTo(6, 9);
      expect(out.lines[2]!.values[i]).toBe(b.close >= b.open ? 1 : 0);
    });
  });

  it("say which import is missing, and convert a library on its own", () => {
    const c = convert(SCRIPT);
    expect(c.ok).toBe(false);
    expect(c.missingLibraries).toEqual(["someone/Helpers/2"]);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toMatchObject({ line: 2, message: expect.stringContaining("add its source to My libraries") });
    const lib = convert(LIB);
    expect(lib).toMatchObject({ ok: true, library: true, libraryName: "Helpers" });
  });

  it("add to a built-in namespace a library is imported as, without hiding it", async () => {
    const lib = `//@version=6\nlibrary("ta")\nexport double(float x) => x * 2`;
    const out = await runWith(convert(`//@version=6\nimport TradingView/ta/7\nindicator("x")\nplot(ta.double(ta.sma(close, 1)), "D")`, { libraries: [{ source: lib }] }));
    bars.forEach((b, i) => expect(out.lines[0]!.values[i]).toBeCloseTo(b.close * 2, 9));
  });

  it("follow a library's own imports", async () => {
    const outer = `//@version=6
library("Outer")
import someone/Helpers/2 as inner
export wide(float mid) => inner.band(mid, 10).height()`;
    const c = convert(`//@version=6\nimport me/Outer/1\nindicator("x")\nplot(Outer.wide(close), "W")`, { libraries: [{ source: LIB }, { source: outer, path: "me/Outer" }] });
    const out = await runWith(c);
    out.lines[0]!.values.forEach((v) => expect(v).toBeCloseTo(40, 9));
  });
});

describe("the original's licence", () => {
  it("is carried to the top of the converted module, with its author", () => {
    const c = convert(`// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// © someone
//@version=6
indicator("Licensed")
// A comment that isn't a licence
plot(close)`);
    expect(c.code.split("\n").slice(0, 3)).toEqual([
      "// Licensed: converted by AlphaResin from a Pine-compatible v6 script, under the original's licence:",
      "//   This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/",
      "//   © someone",
    ]);
    expect(convert(`//@version=6\nindicator("Mine")\nplot(close)`).code.split("\n")[0]).toContain("Edit freely.");
  });
});

describe("what isn't converted is said, with its line", () => {
  it("reports what the language doesn't have and missing libraries, without code", () => {
    const c = convert(`//@version=6
indicator("x")
d = ta.lwma(close, 10)
plot(d)`);
    expect(c.ok).toBe(false);
    expect(c.code).toBe("");
    expect(c.errors).toEqual([expect.objectContaining({ line: 3, message: expect.stringContaining("ta.lwma() isn't converted yet") })]);
    expect(convert(`//@version=6\nstrategy("s")\nq = strategy.nosuch(close)`).errors[0]).toMatchObject({ line: 3, message: expect.stringContaining("strategy.nosuch() isn't converted yet") });
    expect(convert(`//@version=6\nimport User/lib/1 as l\nindicator("x")`).errors[0]!.line).toBe(2);
  });

  it("reports several problems at once, and notes what it simplifies", () => {
    const c = convert(`//@version=6
indicator("x", overlay = true)
a = ta.lwma(close, 10)
b = undefinedThing + 1
plotcandle(open, high, low, close)
varip int n = 0`);
    expect(c.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(c.warnings.map((w) => w.message)).toEqual(expect.arrayContaining([expect.stringContaining("plotcandle"), expect.stringContaining("varip")]));
  });

  it("leaves out data and chart types the Terminal doesn't have, with a note, and converts the rest", async () => {
    const c = convert(`//@version=6
indicator("x", overlay = true)
eps = request.earnings(syminfo.tickerid, earnings.actual)
rev = request.financial(syminfo.tickerid, "TOTAL_REVENUE", "FQ")
rate = request.currency_rate("USD", "USD")
r = request.security(ticker.renko(syminfo.tickerid, "ATR", 10), timeframe.period, close)
plot(na(eps) ? close : eps, "Close")
plot(rate, "Rate")
plot(r, "Renko close")`);
    expect(c.errors).toEqual([]);
    expect(c.warnings.map((w) => w.line)).toEqual(expect.arrayContaining([3, 4, 5, 6]));
    const out = await runWith(c);
    expect(out.lines[0]!.values).toEqual(bars.map((b) => b.close));
    expect(new Set(out.lines[1]!.values)).toEqual(new Set([1]));
    expect(out.lines[2]!.values).toEqual(bars.map((b) => b.close));
  });

  it("passes on syntax errors with their place", () => {
    const c = convert(`//@version=6\nx = (1 + 2`);
    expect(c.ok).toBe(false);
    expect(c.errors[0]!.message).toContain("never closed");
  });
});

describe("request.security on this market", () => {
  // Hourly bars across several UTC days.
  const hourly = makeBars(24 * 12).map((b, i) => ({ ...b, time: Date.UTC(2026, 0, 5) + i * 3_600_000 }));
  const dayOf = (t: number) => Math.floor(t / 86_400_000);
  const days = [...new Set(hourly.map((b) => dayOf(b.time)))];
  const dailyClose = days.map((d) => hourly.filter((b) => dayOf(b.time) === d).at(-1)!.close);

  async function runOn(source: string) {
    const c = convert(source);
    expect(c.errors, c.code).toEqual([]);
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { inputs: Record<string, { default: unknown }>; run: (ctx: unknown, sdk: unknown) => Out } };
    const inputs = Object.fromEntries(Object.entries(mod.default.inputs).map(([k, s]) => [k, s.default]));
    return mod.default.run({ bars: hourly, periodMs: 3_600_000, inputs }, { pine: engine.pine, ta: engine.ta });
  }

  it("gives the last finished day's value, and the day's own on its last bar (lookahead off)", async () => {
    const out = await runOn(`//@version=6
indicator("D close")
plot(request.security(syminfo.tickerid, "D", close), "D")`);
    hourly.forEach((b, i) => {
      const d = days.indexOf(dayOf(b.time));
      const lastOfDay = i === hourly.length - 1 || dayOf(hourly[i + 1]!.time) !== dayOf(b.time);
      const want = lastOfDay ? dailyClose[d]! : d > 0 ? dailyClose[d - 1]! : null;
      expect(out.lines[0]!.values[i], `bar ${i}`).toBe(want);
    });
  });

  it("gives the previous day's value on every bar with expr[1] and lookahead on, the usual no-repaint form", async () => {
    const out = await runOn(`//@version=6
indicator("Prev D")
plot(request.security(syminfo.tickerid, "D", close[1], lookahead = barmerge.lookahead_on), "Prev")`);
    hourly.forEach((b, i) => {
      const d = days.indexOf(dayOf(b.time));
      expect(out.lines[0]!.values[i], `bar ${i}`).toBe(d > 0 ? dailyClose[d - 1]! : null);
    });
  });

  it("runs ta.* on the daily bars, returns tuples, and leaves gaps when asked", async () => {
    const out = await runOn(`//@version=6
indicator("D sma")
[s, c] = request.security(syminfo.tickerid, "D", [ta.sma(close, 3), close], lookahead = barmerge.lookahead_on)
g = request.security(syminfo.tickerid, "D", close, gaps = barmerge.gaps_on)
plot(s, "Sma")
plot(c, "Close")
plot(g, "Gaps")`);
    const sma3 = vec.sma(dailyClose, 3);
    hourly.forEach((b, i) => {
      const d = days.indexOf(dayOf(b.time));
      const want = Number.isNaN(sma3[d]!) ? null : sma3[d]!;
      if (want === null) expect(out.lines[0]!.values[i], `sma ${i}`).toBeNull();
      else expect(out.lines[0]!.values[i] as number, `sma ${i}`).toBeCloseTo(want, 9);
      expect(out.lines[1]!.values[i]).toBe(dailyClose[d]);
      const lastOfDay = i === hourly.length - 1 || dayOf(hourly[i + 1]!.time) !== dayOf(b.time);
      expect(out.lines[2]!.values[i]).toBe(lastOfDay ? dailyClose[d] : null);
    });
  });

  it("reads the timeframe an input names, and the chart's own when it's empty", async () => {
    const c = convert(`//@version=6
indicator("Input tf")
tf = input.timeframe("D", "Timeframe")
plot(request.security(syminfo.tickerid, tf, close[1], lookahead = barmerge.lookahead_on), "Prev")`);
    expect(c.errors, c.code).toEqual([]);
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => Out } };
    const prev = (tf: string) => mod.default.run({ bars: hourly, periodMs: 3_600_000, inputs: { tf } }, { pine: engine.pine, ta: engine.ta }).lines[0]!.values;
    const daily = prev("D");
    hourly.forEach((b, i) => {
      const d = days.indexOf(dayOf(b.time));
      expect(daily[i], `bar ${i}`).toBe(d > 0 ? dailyClose[d - 1]! : null);
    });
    expect(prev("").slice(1)).toEqual(hourly.slice(0, -1).map((b) => b.close));
  });

  it("warms up on older daily bars when the host supplies them, and says which timeframes it asked for", async () => {
    const c = convert(`//@version=6
indicator("D sma")
plot(request.security(syminfo.tickerid, "1D", ta.sma(close, 3), lookahead = barmerge.lookahead_on), "Sma")`);
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => Out } };
    const older = [3, 2, 1].map((k) => ({ time: hourly[0]!.time - k * 86_400_000, open: 1, high: 1, low: 1, close: 10 * k, volume: 1 }));
    const out = mod.default.run({ bars: hourly, periodMs: 3_600_000, inputs: {}, higher: { D: older } }, { pine: engine.pine, ta: engine.ta });
    // The first chart day already has an average: two older days (20 and 10) and its own close.
    expect(out.lines[0]!.values[0]).toBeCloseTo((20 + 10 + dailyClose[0]!) / 3, 9);
    expect([...engine.pine.lastRun()!.requested]).toEqual(["D1"]);
  });

  it("reads a lower timeframe's last bar inside each chart bar, or its own bars when none are given", async () => {
    const source = `//@version=6\nindicator("x")\nplot(request.security(syminfo.tickerid, "15", close), "Last")\nplot(request.security(syminfo.tickerid, "15", ta.sma(close, 2)), "Sma")`;
    const c = convert(source);
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => Out } };
    // Four quarters per hour, closing at the hour's close plus 0, 1, 2, 3; the first hour has none.
    const quarters = hourly.slice(1).flatMap((b) => [0, 1, 2, 3].map((k) => ({ time: b.time + k * 900_000, open: b.open, high: b.high + 5, low: b.low, close: b.close + k, volume: 1 })));
    const out = mod.default.run({ bars: hourly, periodMs: 3_600_000, inputs: {}, higher: { "15": quarters } }, { pine: engine.pine, ta: engine.ta });
    expect(out.lines[0]!.values[0]).toBeNull();
    hourly.slice(1).forEach((b, k) => {
      expect(out.lines[0]!.values[k + 1]).toBeCloseTo(b.close + 3, 9);
      expect(out.lines[1]!.values[k + 1]).toBeCloseTo(b.close + 2.5, 9);
    });
    expect(engine.pine.lastRun()!.approximated.size).toBe(0);
    // Without them: the chart's own bars, and the runtime says so.
    const alone = await runOn(source);
    expect(alone.lines[0]!.values).toEqual(hourly.map((b) => b.close));
    expect([...engine.pine.lastRun()!.approximated]).toEqual(["m15"]);
  });

  it("reads other markets from the bars the host supplies, and na for markets it doesn't carry", async () => {
    const source = `//@version=6
indicator("x")
eth = request.security("BINANCE:ETHUSDT", timeframe.period, close)
[o, c] = request.security("COINBASE:SOLUSD", "D", [open, close])
own = request.security("COINBASE:BTCUSD", timeframe.period, close)
plot(eth, "Eth")
plot(c, "Sol")
plot(own, "Own")`;
    const c = convert(source);
    expect(c.warnings.map((w) => w.message)).toEqual(expect.arrayContaining([expect.stringContaining("BINANCE:ETHUSDT as ETHUSD")]));
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => Out } };
    // ETH's bars: the chart's shifted by an hour, so the first chart bar has none.
    const eth = hourly.slice(1).map((b) => ({ ...b, close: b.close * 10 }));
    const out = mod.default.run({ bars: hourly, periodMs: 3_600_000, inputs: {}, symbol: "BTCUSD", markets: { ETHUSD: eth } }, { pine: engine.pine, ta: engine.ta });
    expect(out.lines[0]!.values[0]).toBeNull();
    expect(out.lines[0]!.values.slice(1)).toEqual(eth.map((b) => b.close));
    expect(out.lines[1]!.values.every((v) => v === null)).toBe(true);
    expect(out.lines[2]!.values).toEqual(hourly.map((b) => b.close));
    expect([...engine.pine.lastRun()!.markets].sort()).toEqual(["ETHUSD", "SOLUSD"]);
  });

  it("reads Heikin Ashi bars made from the chart's own", async () => {
    const out = await runOn(`//@version=6\nindicator("x")\nplot(request.security(ticker.heikinashi(syminfo.tickerid), timeframe.period, close), "HA close")`);
    const ha = engine.pine.heikinAshi(hourly.map((b) => ({ ...b, volume: b.volume ?? NaN })));
    hourly.forEach((_, i) => expect(out.lines[0]!.values[i]).toBeCloseTo(ha[i]!.close, 9));
  });

  it("reads a lower timeframe's bars as an array per chart bar", async () => {
    const c = convert(`//@version=6\nindicator("x")\nv = request.security_lower_tf(syminfo.tickerid, "15", close)\nplot(array.size(v), "Count")\nplot(array.sum(v), "Sum")`);
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => Out } };
    const quarters = hourly.flatMap((b) => [0, 1, 2, 3].map((k) => ({ time: b.time + k * 900_000, open: b.open, high: b.high, low: b.low, close: k, volume: 1 })));
    const out = mod.default.run({ bars: hourly, periodMs: 3_600_000, inputs: {}, higher: { "15": quarters } }, { pine: engine.pine, ta: engine.ta });
    expect(new Set(out.lines[0]!.values)).toEqual(new Set([4]));
    expect(new Set(out.lines[1]!.values)).toEqual(new Set([6]));
  });

  it("reads its own timeframe directly", async () => {
    const out = await runOn(`//@version=6\nindicator("x")\nplot(request.security(syminfo.tickerid, "60", close), "Same")\nplot(timeframe.change("D") ? 1 : 0, "New day")`);
    expect(out.lines[0]!.values).toEqual(hourly.map((b) => b.close));
    expect(out.lines[1]!.values.filter((v) => v === 1)).toHaveLength(days.length);
  });
});

describe("text and symbol inputs", () => {
  const src = `//@version=6
indicator("Text inputs")
greeting = input.string("hello", "Greeting")
market = input.symbol("BINANCE:ETHUSDT", "Market")
notes = input.text_area("one\\ntwo", "Notes")
tf = input.timeframe("D", "Timeframe")
own = input.timeframe(timeframe.period, "Own")
plot(str.length(greeting), "Greeting length")
plot(str.length(market), "Market length")`;

  it("become adjustable text inputs; a symbol says it names a market, a timeframe a timeframe", async () => {
    const { def, converted } = await run(src);
    expect(def.inputs).toEqual({
      greeting: { label: "Greeting", type: "text", default: "hello", maxLength: 200 },
      market: { label: "Market", type: "text", default: "BINANCE:ETHUSDT", maxLength: 200, symbol: true },
      notes: { label: "Notes", type: "text", default: "one\ntwo", maxLength: 2000 },
      tf: { label: "Timeframe", type: "text", default: "D", maxLength: 10, timeframe: true },
      own: { label: "Own", type: "text", default: "", maxLength: 10, timeframe: true },
    });
    expect(converted.warnings).toEqual([]);
  });

  it("reads the value it is given", async () => {
    const { out } = await run(src, { greeting: "hi there", market: "ETHUSD" });
    const lines = (out as unknown as { lines: { title: string; values: (number | null)[] }[] }).lines;
    expect(lines.find((l) => l.title === "Greeting length")!.values.at(-1)).toBe(8);
    expect(lines.find((l) => l.title === "Market length")!.values.at(-1)).toBe(6);
  });
});
