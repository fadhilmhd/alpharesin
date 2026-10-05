import { describe, expect, it } from "vitest";
import { color, start, toneOf, type Pine } from "./pine";
import * as vec from "./ta";

/** 400 bars of a seeded random walk, so every window function sees real variety (and a few gaps). */
function bars(n = 400) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let close = 100;
  return Array.from({ length: n }, (_, i) => {
    const open = close;
    close = Math.max(1, close * (1 + (rnd() - 0.5) * 0.04));
    const high = Math.max(open, close) * (1 + rnd() * 0.01);
    const low = Math.min(open, close) * (1 - rnd() * 0.01);
    return { time: i * 3_600_000, open, high, low, close, volume: 1000 + rnd() * 500 };
  });
}

const B = bars();
const closes = B.map((b) => b.close);
const highs = B.map((b) => b.high);
const lows = B.map((b) => b.low);
const vols = B.map((b) => b.volume);

/** Run `step` once per bar with one call-site state, as a converted script would. */
function stream<T>(step: (P: Pine, st: Record<string, unknown>, i: number) => T): T[] {
  const P = start({ bars: B, periodMs: 3_600_000 });
  const st = {};
  return B.map((_, i) => {
    P.bar(i);
    return step(P, st, i);
  });
}

function same(a: unknown[], b: unknown[], name: string) {
  expect(a.length, name).toBe(b.length);
  a.forEach((x, i) => {
    const y = b[i];
    if (typeof x === "number" && Number.isNaN(x)) expect(Number.isNaN(y as number), `${name} at ${i}: ${x} vs ${y}`).toBe(true);
    else if (typeof x === "number") expect(y as number, `${name} at ${i}`).toBeCloseTo(x, 9);
    else expect(y, `${name} at ${i}`).toBe(x);
  });
}

describe("the Pine runtime's ta.* match the whole-series engine bar for bar", () => {
  it("averages, deviations and windows", () => {
    same(vec.sma(closes, 20), stream((P, st, i) => P.ta.sma(st, closes[i]!, 20)), "sma");
    same(vec.ema(closes, 20), stream((P, st, i) => P.ta.ema(st, closes[i]!, 20)), "ema");
    same(vec.rma(closes, 14), stream((P, st, i) => P.ta.rma(st, closes[i]!, 14)), "rma");
    same(vec.wma(closes, 9), stream((P, st, i) => P.ta.wma(st, closes[i]!, 9)), "wma");
    same(vec.stdev(closes, 20), stream((P, st, i) => P.ta.stdev(st, closes[i]!, 20)), "stdev");
    same(vec.highest(highs, 14), stream((P, st, i) => P.ta.highest(st, highs[i]!, 14)), "highest");
    same(vec.lowest(lows, 14), stream((P, st, i) => P.ta.lowest(st, lows[i]!, 14)), "lowest");
    same(vec.median(closes, 11), stream((P, st, i) => P.ta.median(st, closes[i]!, 11)), "median");
    same(vec.dev(closes, 20), stream((P, st, i) => P.ta.dev(st, closes[i]!, 20)), "dev");
    same(vec.linreg(closes, 20, 0), stream((P, st, i) => P.ta.linreg(st, closes[i]!, 20, 0)), "linreg");
    same(vec.percentrank(closes, 20), stream((P, st, i) => P.ta.percentrank(st, closes[i]!, 20)), "percentrank");
    same(vec.sum(closes, 10), stream((P, st, i) => P.ta.sum(st, closes[i]!, 10)), "sum");
    same(vec.cum(closes), stream((P, st, i) => P.ta.cum(st, closes[i]!)), "cum");
    same(vec.correlation(closes, vols, 20), stream((P, st, i) => P.ta.correlation(st, closes[i]!, vols[i]!, 20)), "correlation");
  });

  it("oscillators, bands and true range", () => {
    same(vec.change(closes, 3), stream((P, st, i) => P.ta.change(st, closes[i]!, 3)), "change");
    same(vec.roc(closes, 10), stream((P, st, i) => P.ta.roc(st, closes[i]!, 10)), "roc");
    same(vec.rsi(closes, 14), stream((P, st, i) => P.ta.rsi(st, closes[i]!, 14)), "rsi");
    const [line, signal, hist] = vec.macd(closes, 12, 26, 9);
    const m = stream((P, st, i) => P.ta.macd(st, closes[i]!, 12, 26, 9));
    same(line, m.map((x) => x[0]!), "macd line");
    same(signal, m.map((x) => x[1]!), "macd signal");
    same(hist, m.map((x) => x[2]!), "macd hist");
    const [basis, upper, lower] = vec.bb(closes, 20, 2);
    const b = stream((P, st, i) => P.ta.bb(st, closes[i]!, 20, 2));
    same(basis, b.map((x) => x[0]!), "bb basis");
    same(upper, b.map((x) => x[1]!), "bb upper");
    same(lower, b.map((x) => x[2]!), "bb lower");
    same(vec.stoch(closes, highs, lows, 14), stream((P, st, i) => P.ta.stoch(st, closes[i]!, highs[i]!, lows[i]!, 14)), "stoch");
    same(vec.cci(closes, 20), stream((P, st, i) => P.ta.cci(st, closes[i]!, 20)), "cci");
    same(vec.vwma(closes, vols, 20), stream((P, st, i) => P.ta.vwma(st, closes[i]!, vols[i]!, 20)), "vwma");
    same(vec.atr(highs, lows, closes, 14), stream((P, st) => P.ta.atr(st, 14)), "atr");
    const [plus, minus, adx] = vec.dmi(highs, lows, closes, 14, 14);
    const d = stream((P, st) => P.ta.dmi(st, 14, 14));
    same(plus, d.map((x) => x[0]!), "dmi +");
    same(minus, d.map((x) => x[1]!), "dmi −");
    same(adx, d.map((x) => x[2]!), "adx");
  });

  it("crosses, pivots and conditions", () => {
    const fast = vec.ema(closes, 9);
    const slow = vec.ema(closes, 21);
    same(vec.crossover(fast, slow), stream((P, st, i) => P.ta.crossover(st, fast[i]!, slow[i]!)), "crossover");
    same(vec.crossunder(fast, slow), stream((P, st, i) => P.ta.crossunder(st, fast[i]!, slow[i]!)), "crossunder");
    same(vec.pivothigh(highs, 5, 5), stream((P, st, i) => P.ta.pivothigh(st, highs[i]!, 5, 5)), "pivothigh");
    same(vec.pivotlow(lows, 5, 5), stream((P, st, i) => P.ta.pivotlow(st, lows[i]!, 5, 5)), "pivotlow");
    const up = vec.crossover(fast, slow);
    same(vec.barssince(up), stream((P, st, i) => P.ta.barssince(st, up[i])), "barssince");
    same(vec.valuewhen(up, closes, 1), stream((P, st, i) => P.ta.valuewhen(st, up[i], closes[i]!, 1)), "valuewhen");
  });
});

describe("the Pine runtime's history, colours and outputs", () => {
  it("keeps a variable's history per bar, and an expression's per site", () => {
    const P = start({ bars: B, periodMs: 3_600_000 });
    const x = P.ser();
    const site = {};
    const seen: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      P.bar(i);
      x.set(i * 10);
      seen.push([x.get(1), P.hist(site, i * 2, 2), P.src("close", 1)]);
    }
    expect(Number.isNaN((seen[0] as number[])[0]!)).toBe(true);
    expect(seen[4]).toEqual([30, 4, B[3]!.close]);
  });

  it("maps colours to the chart's tones", () => {
    expect([color.green, color.red, color.orange, color.blue, color.gray].map(toneOf)).toEqual(["bull", "bear", "warn", "info", "neutral"]);
    expect(color.new(color.green, 100)).toBe("#4caf5000");
    expect(toneOf(color.new(color.green, 100))).toBeNull();
    expect(color.rgb(255, 0, 0)).toBe("#ff0000ff");
  });

  it("turns plots, shapes, levels, fills and alert conditions into the SDK's output", () => {
    const P = start({ bars: B.slice(0, 10), periodMs: 3_600_000 }, { overlay: true });
    for (let i = 0; i < 10; i++) {
      P.bar(i);
      const a = P.plot("p0", P.close, "Close", i < 5 ? color.green : color.red, 2, "plot.style_line");
      const b = P.plot("p1", P.open, "Open", color.blue, 1, undefined);
      P.fill("f0", a, b, color.new(color.green, 80));
      P.hline("h0", 100, "Base", color.gray, "hline.style_dashed");
      P.shape("s0", i === 3, "shape.triangleup", "location.belowbar", color.green, "Buy");
      P.alert("a0", i === 3 || i === 7, "Long setup");
      if (i === 9) P.label.new(i, P.high, "Top", "xloc.bar_index", "yloc.price", color.red, "label.style_label_down");
    }
    const out = P.output();
    expect(out.lines).toHaveLength(2);
    expect((out.lines[0] as { tones: string[] }).tones.slice(4, 6)).toEqual(["bull", "bear"]);
    expect(out.fills).toEqual([expect.objectContaining({ from: "Close", to: "Open" })]);
    expect(out.levels).toEqual([{ value: 100, title: "Base", tone: "neutral", style: "dashed" }]);
    expect(out.markers).toEqual([
      { index: 3, shape: "triangleUp", tone: "bull", price: B[3]!.low, placement: "below", text: "Buy" },
      { index: 9, price: B[9]!.high, shape: "label", tone: "bear", text: "Top", placement: "above" },
    ]);
    expect(out.events.map((e) => [e.index, e.code, e.tone])).toEqual([
      [3, "long_setup", "bull"],
      [7, "long_setup", "bull"],
    ]);
  });
});
