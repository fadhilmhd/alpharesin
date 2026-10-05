import { describe, expect, it } from "vitest";
import { start, type Pine } from "./pine";

/** Bars a minute apart; mintick 1 so ticks read as prices. */
const bars = (rows: [number, number, number, number][]) => rows.map(([open, high, low, close], k) => ({ time: k * 60_000, open, high, low, close, volume: 1 }));

function run(rows: [number, number, number, number][], settings: Record<string, unknown>, script: (P: Pine, i: number) => void) {
  const P = start({ bars: bars(rows), periodMs: 60_000 }, { overlay: true, mintick: 1 });
  for (let i = 0; i < P.n; i++) {
    P.bar(i);
    P.strategy.setup(settings);
    script(P, i);
  }
  const output = P.output();
  return { P, output, report: P.strategyReport()! };
}

const FLAT: [number, number, number, number][] = [
  [100, 101, 99, 100],
  [102, 103, 101, 102],
  [104, 106, 103, 105],
  [107, 108, 106, 107],
];

describe("strategy broker", () => {
  it("fills a market order on the next bar's open, and the script sees the position from that bar", () => {
    const seen: number[] = [];
    const { report } = run(FLAT, {}, (P, i) => {
      if (i === 0) P.strategy.entry("L", "strategy.long");
      if (i === 2) P.strategy.close("L");
      seen.push(P.strategy.position_size);
    });
    expect(seen).toEqual([0, 1, 1, 0]);
    expect(report.trades).toBe(1);
    expect(report.list[0]).toMatchObject({ side: "long", entryId: "L", exitId: "L", entryPrice: 102, exitPrice: 107, entryTime: 60_000, exitTime: 180_000, profit: 5 });
    expect(report.netProfit).toBe(5);
  });

  it("fills on the same bar's close with process_orders_on_close, the last bar included", () => {
    const { report } = run(FLAT, { process_orders_on_close: true }, (P, i) => {
      if (i === 0) P.strategy.entry("L", "strategy.long");
      if (i === 2) P.strategy.close("L");
      if (i === 3) P.strategy.entry("L2", "strategy.long");
    });
    expect(report.list[0]).toMatchObject({ entryPrice: 100, entryTime: 0, exitPrice: 105, exitTime: 120_000, profit: 5 });
    expect(report.openTrades).toBe(1);
  });

  it("brackets an entry with ticks: the target or stop the bar's path reaches first", () => {
    const exits = (bar2: [number, number, number, number]) =>
      run([[100, 100, 100, 100], [100, 102, 99, 101], bar2], {}, (P, i) => {
        if (i === 0) P.strategy.entry("L", "strategy.long");
        P.strategy.exit("TP/SL", "L", undefined, undefined, 5, undefined, 3);
      }).report.list[0];
    // High as near the open as the low: open → high → low, so the target (105) fills first.
    expect(exits([101, 106, 96, 100])).toMatchObject({ exitId: "TP/SL", exitPrice: 105, profit: 5 });
    // The high falls short of the target; on the way down the stop (97) fills.
    expect(exits([101, 104, 96, 97])).toMatchObject({ exitPrice: 97, profit: -3 });
    // A gap through the stop fills at the open.
    expect(exits([95, 96, 94, 95])).toMatchObject({ exitPrice: 95, profit: -5 });
  });

  it("trails a stop once its activation level is reached", () => {
    const { report } = run(
      [
        [100, 100, 100, 100],
        [100, 103, 99, 102],
        [102, 108, 101, 107],
        [107, 107.5, 104, 105],
      ],
      {},
      (P, i) => {
        if (i === 0) P.strategy.entry("L", "strategy.long");
        P.strategy.exit("Trail", "L", undefined, undefined, undefined, undefined, undefined, undefined, undefined, 5, 2);
      },
    );
    // Activated at 105, high 108 → stop 106, hit on bar 3's way down.
    expect(report.list[0]).toMatchObject({ exitId: "Trail", exitPrice: 106, profit: 6 });
  });

  it("reverses on an opposite entry and respects pyramiding", () => {
    const rev = run(
      [
        [100, 100, 100, 100],
        [100, 101, 99, 100],
        [110, 111, 109, 110],
      ],
      {},
      (P, i) => {
        if (i === 0) P.strategy.entry("L", "strategy.long");
        if (i === 1) P.strategy.entry("S", "strategy.short");
      },
    );
    expect(rev.report.list[0]).toMatchObject({ entryId: "L", exitId: "S", exitPrice: 110, profit: 10 });
    expect(rev.P.strategy.position_size).toBe(-1);

    const adds = (pyramiding: number) =>
      run(FLAT, { pyramiding }, (P, i) => {
        if (i < 2) P.strategy.entry(`L${i}`, "strategy.long");
      }).P.strategy.opentrades;
    expect(adds(0)).toBe(1);
    expect(adds(2)).toBe(2);
  });

  it("sizes by equity and charges commission on both sides", () => {
    const sized = run(FLAT, { initial_capital: 1000, default_qty_type: "strategy.percent_of_equity", default_qty_value: 100 }, (P, i) => {
      if (i === 0) P.strategy.entry("L", "strategy.long");
      if (i === 2) P.strategy.close("L");
    });
    // Sized on the placing bar: its equity (1000) and close (100); rounded down to a millionth.
    expect(sized.report.list[0]!.qty).toBe(10);
    expect(sized.report.netProfit).toBeCloseTo(10 * 5, 9);

    const fees = run(FLAT, { commission_type: "strategy.commission.percent", commission_value: 0.1 }, (P, i) => {
      if (i === 0) P.strategy.entry("L", "strategy.long");
      if (i === 2) P.strategy.close("L");
    });
    expect(fees.report.netProfit).toBeCloseTo(5 - 0.102 - 0.107, 9);
    expect(fees.P.strategy.trade("closed", "commission", 0)).toBeCloseTo(0.209, 9);
  });

  it("reports entries as events on the bar that placed them, and marks every fill", () => {
    const { output } = run(FLAT, {}, (P, i) => {
      if (i === 0) P.strategy.entry("Long", "strategy.long");
      if (i === 1) P.strategy.entry("Breakout", "strategy.short");
    });
    expect(output.events).toEqual([
      { index: 0, code: "entry_long_long", label: "Long entry", tone: "bull" },
      { index: 1, code: "entry_short_breakout", label: "Short entry: Breakout", tone: "bear" },
    ]);
    expect(output.markers).toEqual([
      { index: 1, price: 102, shape: "triangleUp", tone: "bull", text: "Long", placement: "below" },
      { index: 2, price: 104, shape: "cross", tone: "neutral", text: "Breakout", placement: "above" },
      { index: 2, price: 104, shape: "triangleDown", tone: "bear", text: "Breakout", placement: "above" },
    ]);
  });
});
