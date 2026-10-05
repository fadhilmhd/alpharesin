import { describe, expect, it } from "vitest";
import { compareParity, parseTvCsv, ParityError } from "./parity";

describe("reading a TradingView chart export", () => {
  it("takes the bars, the plotted columns and, if there, volume", () => {
    const csv = `time,open,high,low,close,"Basis, 20",Upper,Volume\n1700000000,10,12,9,11,10.5,,500\n1700014400,11,13,10,12,11.5,13.1,NaN\n1700028800,12,14,11,13,12.5,14.2,700\n`;
    const tv = parseTvCsv(csv);
    expect(tv.bars[0]).toEqual({ time: 1_700_000_000_000, open: 10, high: 12, low: 9, close: 11, volume: 500 });
    expect(tv.bars[1]!.volume).toBeNull();
    expect(tv.periodMs).toBe(4 * 3_600_000);
    expect(tv.hasVolume).toBe(true);
    expect(tv.columns.map((c) => c.title)).toEqual(["Basis, 20", "Upper"]);
    expect(tv.columns[1]!.values).toEqual([null, 13.1, 14.2]);
  });

  it("reads ISO times, and refuses what isn't an export", () => {
    const tv = parseTvCsv(`time,open,high,low,close,Plot\n2026-01-01T00:00:00Z,1,1,1,1,5\n2026-01-01T01:00:00Z,1,1,1,1,6`);
    expect(tv.bars.map((b) => b.time)).toEqual([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1, 1)]);
    expect(tv.hasVolume).toBe(false);
    expect(() => parseTvCsv("a,b\n1,2")).toThrow(ParityError);
    expect(() => parseTvCsv("time,open,high,low,close")).toThrow("no rows");
  });
});

describe("comparing a script with the export", () => {
  const n = 100;
  const exact = Array.from({ length: n }, (_, i) => i * 1.5);

  it("says match, warm-up, settling or differs for each column", () => {
    const report = compareParity(
      [
        { title: "Exact", values: exact },
        { title: "Late", values: exact },
        { title: "Settling", values: exact.map((x) => x + 10) },
        { title: "Wrong", values: exact },
        { title: "Volume MA", values: exact },
      ],
      [
        { title: "Exact", values: exact.map((x) => x + 1e-9) },
        // Differs for 30 bars, then agrees to the end.
        { title: "Late", values: exact.map((x, i) => (i < 30 ? x + 5 : x)) },
        // Off by a shrinking amount: an average still settling.
        { title: "Settling", values: exact.map((x, i) => x + 10 + 0.5 * 0.97 ** i) },
        { title: "Wrong", values: exact.map((x) => x * 2 + 1) },
        { title: "Only ours", values: exact },
      ],
    );
    const status = Object.fromEntries(report.columns.map((c) => [c.title, c.status]));
    expect(status).toEqual({ Exact: "match", Late: "warmup", Settling: "converging", Wrong: "differs", "Only ours": "missing" });
    expect(report.columns.find((c) => c.title === "Late")!.from).toBe(30);
    expect(report.ignored).toEqual(["Volume MA"]);
    expect(report.verdict).toBe("partial");
  });

  it("pairs repeated titles in order and calls a clean run a match", () => {
    const report = compareParity(
      [
        { title: "Plot", values: [1, 2, 3] },
        { title: "Plot", values: [4, 5, null] },
      ],
      [
        { title: "Plot", values: [1, 2, 3] },
        { title: "Plot 2", values: [4, 5, null] },
      ],
    );
    expect(report.columns.map((c) => [c.title, c.status])).toEqual([["Plot", "match"], ["Plot", "match"]]);
    expect(report.verdict).toBe("match");
  });

  it("counts a gap on one side as a difference", () => {
    const report = compareParity([{ title: "X", values: [1, 2, 3] }], [{ title: "X", values: [1, null, 3] }]);
    expect(report.columns[0]).toMatchObject({ status: "differs", equal: 2, example: { index: 1, tv: 2, ours: null } });
    expect(report.verdict).toBe("differs");
  });
});
