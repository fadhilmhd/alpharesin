import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as engine from "@alphapine/engine";
import { describe, expect, it } from "vitest";
import { convert } from "./convert";
import { compareParity, parseTvCsv, type Column, type TvExport } from "./parity";

/**
 * Each conformance script against its TradingView export, saved as
 * conformance/exports/<script name>.csv (or in RESIN_CONFORMANCE_DIR). The
 * exports are TradingView's data: kept locally, never published. Prints every
 * column's status; fails when a column differs, so a change that breaks one
 * shows here. Scripts without an export are skipped.
 *
 * TradingView computes from the start of its own history, longer than an
 * export. Cumulative series are compared by how they move bar to bar, and a
 * strategy from the first bar both are flat, with the same equity there.
 */

const scripts = join(__dirname, "../conformance");
const exports = process.env.RESIN_CONFORMANCE_DIR ?? join(__dirname, "../conformance/exports");
const CONFORMANCE = readdirSync(scripts).filter((f) => f.endsWith(".pine")).sort();

/** Series that carry their whole history: compared by their steps. */
const BY_STEP: Record<string, "add" | "mul" | "max" | "min"> = { cum: "add", obv: "add", accdist: "add", pvt: "add", wad: "add", pvi: "mul", nvi: "mul", max: "max", min: "min" };
/** A strategy's columns: as they stand, or as they've moved since the bars line up. */
const STRATEGY_LEVEL = new Set(["position", "avg price", "openprofit"]);
const STRATEGY_STEP = new Set(["netprofit", "equity", "closed trades", "wins", "losses"]);
/** Bars before a strategy is lined up: its indicators settle first. */
const SETTLE = 300;
/** Its deepest fall since its own first bar: not comparable on a shorter history. */
const STRATEGY_HISTORY = new Set(["max drawdown"]);

async function run(source: string, tv: TvExport): Promise<Column[]> {
  const c = convert(source);
  expect(c.errors).toEqual([]);
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(c.code).toString("base64")}`)) as { default: { run: (ctx: unknown, sdk: unknown) => unknown } };
  mod.default.run({ bars: tv.bars, periodMs: tv.periodMs, inputs: {}, mintick: tv.tick }, { pine: engine.pine, ta: engine.ta });
  return engine.pine.lastRun()!.columns();
}

type Line = { title: string; status: string; detail: string };
const time = (tv: TvExport, k: number) => new Date(tv.bars[k]?.time ?? 0).toISOString().slice(0, 16);
const close = (a: number, b: number, scale = 1) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(scale));

/** How a cumulative series moves: each step against TradingView's. */
function bySteps(tv: TvExport, title: string, how: "add" | "mul" | "max" | "min", theirs: (number | null)[], ours: (number | null)[]): Line {
  let compared = 0;
  let first = -1;
  for (let i = 1; i < theirs.length; i++) {
    const [a0, a1, b0, b1] = [theirs[i - 1], theirs[i], ours[i - 1], ours[i]];
    if (a0 == null || a1 == null) continue;
    let ok: boolean;
    if (how === "add") ok = b0 != null && b1 != null && close(a1 - a0, b1 - b0, a1);
    else if (how === "mul") ok = b0 != null && b1 != null && close(a1 / a0, b1 / b0);
    // The running extreme: TradingView's moves exactly as "the extreme so far" would on these bars.
    else ok = a1 === (how === "max" ? Math.max(a0, tv.bars[i]!.high) : Math.min(a0, tv.bars[i]!.low));
    compared++;
    if (!ok && first < 0) first = i;
  }
  return first < 0
    ? { title, status: "steps", detail: ` every bar's ${how === "mul" ? "ratio" : how === "add" ? "change" : "new extreme"} agrees (${compared} bars)` }
    : { title, status: "differs", detail: ` steps first differ at ${time(tv, first)}` };
}

describe("conformance with TradingView", () => {
  for (const file of CONFORMANCE) {
    const csv = join(exports, file.replace(/\.pine$/, ".csv"));
    it.runIf(existsSync(csv))(`${file} matches its export`, { timeout: 180_000 }, async () => {
      const tv = parseTvCsv(readFileSync(csv, "utf8"));
      let source = readFileSync(join(scripts, file), "utf8");
      let ours = await run(source, tv);
      const lines: Line[] = [];
      const theirs = new Map(tv.columns.map((c) => [c.title, c.values]));
      const mine = () => new Map(ours.map((c) => [c.title, c.values]));

      if (/^strategy\(/m.test(source)) {
        // Line the strategies up: the first bar both are flat, then the same equity there.
        const tp = theirs.get("position")!;
        const op = mine().get("position")!;
        // After the averages it trades on have settled on the export's history (ATR's took 160 bars in script 1).
        const k = tp.findIndex((v, i) => i > SETTLE && v === 0 && op[i] === 0 && tp[i - 1] === 0 && op[i - 1] === 0);
        expect(k, "no bar where both strategies are flat").toBeGreaterThan(0);
        // A different starting capital also resizes the trades before k: adjust until the equity there is TradingView's.
        const base = source;
        let capital = Number(/initial_capital\s*=\s*([\d.]+)/.exec(source)![1]);
        for (let step = 0; step < 30; step++) {
          const gap = theirs.get("equity")![k]! - mine().get("equity")![k]!;
          if (Math.abs(gap) < 1e-7) break;
          capital += gap;
          source = base.replace(/initial_capital\s*=\s*[\d.]+/, `initial_capital = ${capital}`);
          ours = await run(source, tv);
        }
        const m = mine();
        console.log(`\n${file}: lined up from ${time(tv, k)} (bar ${k}), TradingView's equity there ${theirs.get("equity")![k]!.toFixed(2)}`);
        for (const [title, values] of theirs) {
          const own = m.get(title);
          if (!own) continue;
          if (STRATEGY_HISTORY.has(title)) {
            lines.push({ title, status: "history", detail: " depends on all of TradingView's history; not compared" });
            continue;
          }
          const from = STRATEGY_STEP.has(title) ? k : 0;
          const shift = (v: (number | null)[]) => v.map((x, i) => (i < k || x == null ? null : STRATEGY_STEP.has(title) ? x - v[from]! : x));
          if (!STRATEGY_LEVEL.has(title) && !STRATEGY_STEP.has(title)) continue;
          // TradingView leaves the bar still forming without strategy values: compared where it has them.
          const col = compareParity([{ title, values: shift(values) }], [{ title, values: shift(own).map((x, i) => (values[i] == null ? null : x)) }]).columns[0]!;
          const ex = col.example;
          lines.push({ title, status: col.status, detail: col.status === "differs" && ex ? ` first at ${time(tv, ex.index)}: TV ${ex.tv} · AlphaResin ${ex.ours} (${col.equal}/${col.compared} equal)` : ` ${col.equal}/${col.compared} bars${STRATEGY_STEP.has(title) ? " (moves since the line-up)" : ""}` });
        }
      } else {
        const m = mine();
        const report = compareParity(
          tv.columns.filter((c) => !BY_STEP[c.title]),
          ours.filter((c) => !BY_STEP[c.title]),
        );
        console.log(`\n${file}: ${report.bars} bars · tick ${tv.tick}${tv.hasVolume ? "" : " · NO VOLUME in the export"}`);
        for (const col of report.columns) {
          const ex = col.example;
          lines.push({ title: col.title, status: col.status, detail: col.status === "differs" && ex ? ` first at ${time(tv, ex.index)}: TV ${ex.tv} · AlphaResin ${ex.ours} (${col.equal}/${col.compared} equal)` : col.status === "warmup" ? ` from bar ${col.from}` : col.status === "converging" ? ` last diff ${col.lastDiff.toPrecision(2)}` : "" });
        }
        for (const [title, how] of Object.entries(BY_STEP)) {
          const values = theirs.get(title);
          const own = m.get(title);
          if (values && own) lines.push(bySteps(tv, title, how, values, own));
        }
      }
      for (const l of lines) console.log(`  ${l.status.padEnd(10)} ${l.title}${l.detail}`);
      expect(lines.filter((l) => l.status === "differs" || l.status === "missing").map((l) => l.title)).toEqual([]);
    });
  }
});
