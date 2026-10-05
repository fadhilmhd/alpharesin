import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as engine from "@alphapine/engine";
import { describe, expect, it } from "vitest";
import { convert } from "./convert";

/**
 * The conformance scripts (../conformance/*.pine): many built-ins plotted on
 * one chart, to export once from TradingView and compare column by column
 * (conformance.compare.test.ts). Here: each converts cleanly and runs.
 */

const dir = join(__dirname, "../conformance");
export const CONFORMANCE = readdirSync(dir).filter((f) => f.endsWith(".pine")).sort();

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let px = 100;
const bars = Array.from({ length: 2000 }, (_, i) => {
  const open = px;
  px = Math.max(1, px * (1 + (rnd() - 0.5) * 0.03));
  return { time: Date.UTC(2026, 0, 1) + i * 3_600_000, open, high: Math.max(open, px) * (1 + rnd() * 0.01), low: Math.min(open, px) * (1 - rnd() * 0.01), close: px, volume: 1000 + rnd() * 500 };
});

describe("conformance scripts", () => {
  for (const file of CONFORMANCE) {
    it(`${file} converts with no notes and runs, every plot under its own title`, async () => {
      const c = convert(readFileSync(join(dir, file), "utf8"));
      expect(c.errors).toEqual([]);
      expect(c.warnings).toEqual([]);
      const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => unknown } };
      mod.default.run({ bars, periodMs: 3_600_000, inputs: {}, mintick: 0.01 }, { pine: engine.pine, ta: engine.ta });
      const cols = engine.pine.lastRun()!.columns();
      expect(cols.length).toBeGreaterThan(5);
      expect(cols.length).toBeLessThanOrEqual(64);
      expect(new Set(cols.map((x) => x.title)).size).toBe(cols.length);
      // Every column has values (sparse ones, like pivots, somewhere).
      for (const col of cols) expect(col.values.some((v) => v !== null), col.title).toBe(true);
    });
  }
});
