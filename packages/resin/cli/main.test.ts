import { describe, expect, it } from "vitest";
import { columnsCsv, parseBars, type ResinModule } from "../src/runner";
import { main, parseArgs } from "./main";

const EMA = `//@version=6
indicator("EMA pair", overlay = true)
fastLen = input.int(9, "Fast length", minval = 1)
f = ta.ema(close, fastLen)
s = ta.ema(close, 21)
plot(f, "Fast")
plot(s, "Slow")
`;

const LEFT_OUT = `//@version=6
indicator("With a footprint")
x = footprint.poc()
plot(close, "Close")
`;

const BROKEN = `//@version=6
indicator("Broken")
plot(ta.nosuchthing(close), "x")
`;

const STRATEGY = `//@version=6
strategy("Cross strategy", overlay = true, initial_capital = 10000)
f = ta.sma(close, 5)
s = ta.sma(close, 20)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")
`;

const LIBRARY = `//@version=6
// @description Doubles a series.
library("Twice")
export twice(float x) => x * 2
`;

const USES_LIBRARY = `//@version=6
indicator("Uses a library")
import someone/Twice/1 as tw
plot(tw.twice(close), "Twice")
`;

/** Synthetic hourly bars: a seeded walk, so every run reads the same file. */
function barsCsv(n = 300): string {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let price = 100;
  const rows = ["Time,Open,High,Low,Close,Volume"];
  for (let i = 0; i < n; i++) {
    const open = price;
    price = Math.max(1, price + (rnd() - 0.48) * 2);
    const high = Math.max(open, price) + rnd();
    const low = Math.min(open, price) - rnd();
    rows.push([Date.UTC(2026, 0, 1) / 1000 + i * 3600, open.toFixed(2), high.toFixed(2), low.toFixed(2), price.toFixed(2), Math.round(rnd() * 1000)].join(","));
  }
  return rows.join("\n");
}

function setup(files: Record<string, string>) {
  const written: Record<string, string> = {};
  let out = "";
  let err = "";
  const io = {
    readFile: (p: string) => {
      if (!(p in files)) throw Object.assign(new Error("missing"), { code: "ENOENT", path: p });
      return files[p]!;
    },
    writeFile: (p: string, t: string) => void (written[p] = t),
    out: (t: string) => void (out += t),
    err: (t: string) => void (err += t),
    load: async (code: string) => (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as ResinModule,
    version: "9.9.9",
  };
  return { io, written, out: () => out, err: () => err };
}

describe("alpharesin command line", () => {
  it("reads its options, repeated and inline", () => {
    const a = parseArgs(["run", "s.pine", "--bars=b.csv", "-i", "Fast length=12", "--input", "x=1", "-l", "a.pine", "--lib", "b.pine", "--json"]);
    expect(a).toMatchObject({ command: "run", file: "s.pine", bars: "b.csv", inputs: { "Fast length": "12", x: "1" }, libs: ["a.pine", "b.pine"], json: true });
    expect(() => parseArgs(["run", "--bars"])).toThrow(/needs a value/);
    expect(() => parseArgs(["check", "a", "--nope"])).toThrow(/Unknown option/);
    expect(parseArgs(["run", "s.pine", "-i", "Strike (0 = auto)=82000"]).inputs).toEqual({ "Strike (0 = auto)": "82000" });
  });

  it("answers help, version and bad usage with the right exit status", async () => {
    const t = setup({});
    expect(await main(["--version"], t.io)).toBe(0);
    expect(t.out()).toBe("9.9.9\n");
    expect(await main(["--help"], t.io)).toBe(0);
    expect(t.out()).toContain("alpharesin convert <script.pine>");
    expect(await main([], setup({}).io)).toBe(2);
    expect(await main(["frobnicate", "x.pine"], setup({}).io)).toBe(2);
    expect(await main(["run", "s.pine"], setup({}).io)).toBe(2);
    const missing = setup({});
    expect(await main(["check", "nope.pine"], missing.io)).toBe(2);
    expect(missing.err()).toContain("No such file: nope.pine");
  });

  it("checks a script and says what it left out, line by line", async () => {
    const ok = setup({ "a.pine": EMA });
    expect(await main(["check", "a.pine"], ok.io)).toBe(0);
    expect(ok.out()).toContain("Converts: EMA pair (indicator, on the price chart)");
    const partial = setup({ "b.pine": LEFT_OUT });
    expect(await main(["check", "b.pine"], partial.io)).toBe(0);
    expect(partial.out()).toMatch(/Left out, with the reason \(1\)\n {2}line 3: footprint\.poc\(\) needs footprint data the host doesn't carry/);
    const broken = setup({ "c.pine": BROKEN });
    expect(await main(["check", "c.pine"], broken.io)).toBe(1);
    expect(broken.out()).toMatch(/Doesn't convert yet[\s\S]*line 3:/);
  });

  it("converts to a module, on screen or into a file", async () => {
    const t = setup({ "a.pine": EMA });
    expect(await main(["convert", "a.pine"], t.io)).toBe(0);
    expect(t.out()).toContain("export default {");
    const f = setup({ "a.pine": EMA });
    expect(await main(["convert", "a.pine", "-o", "a.js"], f.io)).toBe(0);
    expect(f.written["a.js"]).toContain('name: "EMA pair"');
    expect(f.err()).toContain("Wrote a.js");
    const j = setup({ "a.pine": EMA });
    expect(await main(["convert", "a.pine", "--json"], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject({ ok: true, name: "EMA pair", errors: [], warnings: [] });
    expect(await main(["convert", "c.pine"], setup({ "c.pine": BROKEN }).io)).toBe(1);
  });

  it("runs on a bars file and writes every plot as a column, inputs at their defaults or as given", async () => {
    const t = setup({ "a.pine": EMA, "b.csv": barsCsv() });
    expect(await main(["run", "a.pine", "--bars", "b.csv"], t.io)).toBe(0);
    const out = t.out().trim().split("\n");
    expect(out[0]).toBe("time,open,high,low,close,volume,Fast,Slow");
    expect(out).toHaveLength(301);
    const lastFast = Number(out.at(-1)!.split(",")[6]);
    const t12 = setup({ "a.pine": EMA, "b.csv": barsCsv() });
    expect(await main(["run", "a.pine", "--bars", "b.csv", "-i", "Fast length=12"], t12.io)).toBe(0);
    expect(Number(t12.out().trim().split("\n").at(-1)!.split(",")[6])).not.toBe(lastFast);
    const bad = setup({ "a.pine": EMA, "b.csv": barsCsv() });
    expect(await main(["run", "a.pine", "--bars", "b.csv", "-i", "Fast length=0"], bad.io)).toBe(1);
    expect(bad.err()).toContain("between 1");
    const unknown = setup({ "a.pine": EMA, "b.csv": barsCsv() });
    expect(await main(["run", "a.pine", "--bars", "b.csv", "-i", "nope=1"], unknown.io)).toBe(1);
    expect(unknown.err()).toContain('"nope" isn\'t one of this script\'s inputs');
  });

  it("runs a strategy and sums up its results", async () => {
    const t = setup({ "s.pine": STRATEGY, "b.csv": barsCsv(600) });
    expect(await main(["run", "s.pine", "--bars", "b.csv"], t.io)).toBe(0);
    expect(t.err()).toMatch(/Cross strategy: \d+ closed trades, net -?\d+\.\d\d/);
    const j = setup({ "s.pine": STRATEGY, "b.csv": barsCsv(600) });
    expect(await main(["run", "s.pine", "--bars", "b.csv", "--json"], j.io)).toBe(0);
    expect(JSON.parse(j.out()).strategy).toMatchObject({ initialCapital: 10000 });
  });

  it("reads the libraries a script imports", async () => {
    const without = setup({ "u.pine": USES_LIBRARY });
    expect(await main(["check", "u.pine"], without.io)).toBe(1);
    expect(without.out()).toContain("--lib");
    const t = setup({ "u.pine": USES_LIBRARY, "twice.pine": LIBRARY, "b.csv": barsCsv(50) });
    expect(await main(["run", "u.pine", "--bars", "b.csv", "--lib", "twice.pine"], t.io)).toBe(0);
    const [head, first] = t.out().split("\n");
    expect(head).toBe("time,open,high,low,close,volume,Twice");
    const cols = first!.split(",");
    expect(Number(cols[6])).toBeCloseTo(Number(cols[4]) * 2, 9);
  });

  it("compares with a chart export: matches its own run, and says where a column differs", async () => {
    // An export as TradingView writes one: time in seconds, "Volume", then the plots.
    const run = setup({ "a.pine": EMA, "b.csv": barsCsv() });
    await main(["run", "a.pine", "--bars", "b.csv"], run.io);
    const csv = run.out().replace(/^time,open,high,low,close,volume/, "time,open,high,low,close,Volume").replace(/^(\d{4}-[^,]+)/gm, (iso) => String(Date.parse(iso) / 1000));
    const t = setup({ "a.pine": EMA, "tv.csv": csv });
    expect(await main(["parity", "a.pine", "--tv", "tv.csv"], t.io)).toBe(0);
    expect(t.out()).toMatch(/^Matches TradingView on 300 bars\n {2}match {6}Fast: every bar\n {2}match {6}Slow: every bar/);
    const bars = parseBars(barsCsv());
    const edited = columnsCsv(bars.bars, [{ title: "Fast", values: bars.bars.map(() => 1) }, { title: "Slow", values: bars.bars.map(() => 2) }]).replace("volume", "Volume");
    const d = setup({ "a.pine": EMA, "tv.csv": edited });
    expect(await main(["parity", "a.pine", "--tv", "tv.csv"], d.io)).toBe(1);
    expect(d.out()).toMatch(/Differs from TradingView[\s\S]*differs {4}Fast: 0 of 300 bars agree/);
  });
});
