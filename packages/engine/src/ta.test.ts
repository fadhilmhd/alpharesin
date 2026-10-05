import { describe, expect, it } from "vitest";
import * as ta from "./ta";
import { change, linreg, percentileNearestRank, sum } from "./ta";

describe("sum (Pine's math.sum)", () => {
  it("sums the last `length` values once that many bars exist", () => {
    expect(sum([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 6, 9, 12]);
  });

  it("is NaN while the window holds a NaN, as for a leading ta.change", () => {
    const abs = change([10, 11, 9, 12, 12]).map(Math.abs); // [NaN, 1, 2, 3, 0]
    expect(sum(abs, 2)).toEqual([NaN, NaN, 3, 5, 3]);
    expect(sum(abs, 4)).toEqual([NaN, NaN, NaN, NaN, 6]);
  });
});

describe("linreg (Pine's ta.linreg)", () => {
  it("returns the line itself on exactly linear data, at any offset", () => {
    const line = [5, 7, 9, 11, 13, 15];
    expect(linreg(line, 4, 0).slice(3)).toEqual([11, 13, 15]);
    expect(linreg(line, 4, 1).slice(3)).toEqual([9, 11, 13]);
    // Offset past the window reads the extension of the fitted line backwards.
    expect(linreg(line, 4, 4)[5]).toBeCloseTo(7, 12);
  });

  it("fits least squares: newest-bar value and slope of noisy data", () => {
    // x = 0..3, y = 1, 3, 2, 4: slope 0.8, intercept 1.3 -> value at x = 3 is 3.7, at x = 2 is 2.9.
    const y = [1, 3, 2, 4];
    expect(linreg(y, 4, 0)[3]).toBeCloseTo(3.7, 12);
    expect(linreg(y, 4, 1)[3]).toBeCloseTo(2.9, 12);
    expect(linreg(y, 4, 0)[3]! - linreg(y, 4, 1)[3]!).toBeCloseTo(0.8, 12);
  });

  it("is NaN before `length` bars and while the window holds a NaN", () => {
    const r = linreg([1, NaN, 3, 4, 5, 6], 3);
    expect(r.slice(0, 4).every(Number.isNaN)).toBe(true);
    expect(r[4]).toBeCloseTo(5, 12);
    expect(r[5]).toBeCloseTo(6, 12);
  });
});

describe("percentileNearestRank (sliding sorted window)", () => {
  // The definition it must keep: sort the window's non-NaN values every bar.
  const naive = (src: number[], length: number, pct: number) =>
    src.map((_, i) => {
      if (i < length - 1) return NaN;
      const v = src.slice(i - length + 1, i + 1).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
      if (v.length === 0) return NaN;
      return v[Math.min(Math.max(1, Math.ceil((pct / 100) * v.length)), v.length) - 1]!;
    });

  it("matches sorting every window, with duplicates and NaNs", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const src = Array.from({ length: 600 }, (_, i) => (i < 25 || rnd() < 0.05 ? NaN : Math.round(rnd() * 40) / 4));
    for (const [length, pct] of [[1, 50], [5, 0], [20, 15], [20, 85], [100, 30], [100, 100], [252, 80]] as const)
      expect(percentileNearestRank(src, length, pct), `${length}/${pct}`).toEqual(naive(src, length, pct));
  });

  it("is NaN before `length` bars and over an all-NaN window", () => {
    expect(percentileNearestRank([NaN, NaN, NaN, 4, 2], 3, 50)).toEqual([NaN, NaN, NaN, 4, 2]);
  });
});

describe("common oscillators and bands", () => {
  it("rsi: Wilder averages of gains and losses, 100 with no losses", () => {
    const r = ta.rsi([1, 2, 1, 2, 1], 2);
    expect(r.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(r[2]).toBeCloseTo(50, 9);
    expect(r[3]).toBeCloseTo(75, 9);
    expect(ta.rsi([1, 2, 3, 4, 5], 2)[4]).toBe(100);
  });

  it("macd: zero on a flat market once warmed up", () => {
    const [line, signal, hist] = ta.macd(new Array(60).fill(10), 12, 26, 9);
    expect(line[59]).toBe(0);
    expect(signal[59]).toBe(0);
    expect(hist[59]).toBe(0);
    expect(Number.isNaN(line[10]!)).toBe(true);
  });

  it("bb: the average plus and minus the population deviation", () => {
    const [basis, upper, lower] = ta.bb([1, 2, 3], 3, 2);
    expect(basis[2]).toBe(2);
    expect(upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 9);
    expect(lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 9);
  });

  it("stoch, roc, mom, vwma, dev and cci", () => {
    expect(ta.stoch([1, 3, 5], [2, 4, 6], [0, 2, 4], 3)[2]).toBeCloseTo((5 / 6) * 100, 9);
    expect(ta.roc([100, 110], 1)[1]).toBeCloseTo(10, 9);
    expect(ta.mom([100, 110], 1)[1]).toBe(10);
    expect(ta.vwma([1, 2], [1, 3], 2)[1]).toBe(1.75);
    expect(ta.dev([1, 2, 3], 3)[2]).toBeCloseTo(2 / 3, 9);
    expect(ta.cci([1, 2, 3], 3)[2]).toBeCloseTo(100, 9);
  });
});
