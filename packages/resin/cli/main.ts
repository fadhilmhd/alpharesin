import { convert, type Converted, type Issue } from "../src/convert";
import { compareParity, parseTvCsv, ParityError } from "../src/parity";
import { columnsCsv, parseBars, resolveInputs, runScript, RunError, type ResinModule } from "../src/runner";

/**
 * The `alpharesin` command. Everything it touches comes through `io`, so the
 * tests run it without a file system; bin.ts wires it to Node.
 */
export interface Io {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  out(text: string): void;
  err(text: string): void;
  /** Load a converted module from its code (an ES module as text). */
  load(code: string): Promise<ResinModule>;
  version: string;
}

export const HELP = `alpharesin: Pine-compatible scripts in, AlphaPine SDK modules out.

Usage
  alpharesin convert <script.pine> [-o module.js]    Convert a script
  alpharesin check <script.pine>                     Say what converts and what is left out
  alpharesin run <script.pine> --bars <bars.csv>     Run it on your bars; plotted values as CSV
  alpharesin parity <script.pine> --tv <export.csv>  Compare with a TradingView chart export

Options
  -l, --lib <file.pine>      A library the script imports (repeat for each)
  -i, --input <name=value>   Set an input by its name or label (repeat for each)
  -o, --out <file>           Write the result to a file instead of the screen
      --bars <file.csv>      Bars: time, open, high, low, close[, volume]; UTC
      --tv <file.csv>        A chart's "Export chart data" file, with the script on it
      --symbol <name>        The chart's market, e.g. BTCUSD
      --mintick <step>       The market's price step (default: read from the prices)
      --json                 Machine-readable output
  -h, --help                 This help
  -v, --version              The version

Exit status: 0 done, 1 the script doesn't convert or doesn't match, 2 bad usage.
Pine Script® is a trademark of TradingView, Inc.; AlphaResin is independent of it.
`;

class UsageError extends Error {}

interface Args {
  command: string | undefined;
  file: string | undefined;
  out?: string;
  libs: string[];
  inputs: Record<string, string>;
  bars?: string;
  tv?: string;
  symbol?: string;
  mintick?: number;
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { command: undefined, file: undefined, libs: [], inputs: {}, json: false, help: false, version: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined || (v.startsWith("-") && v.length > 1)) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--version":
        a.version = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "-o":
      case "--out":
        a.out = value();
        break;
      case "-l":
      case "--lib":
        a.libs.push(value());
        break;
      case "-i":
      case "--input": {
        const v = value();
        const eq = v.indexOf("=");
        if (eq < 1) throw new UsageError(`--input takes name=value, not "${v}"`);
        a.inputs[v.slice(0, eq).trim()] = v.slice(eq + 1).trim();
        break;
      }
      case "--bars":
        a.bars = value();
        break;
      case "--tv":
        a.tv = value();
        break;
      case "--symbol":
        a.symbol = value();
        break;
      case "--mintick": {
        const n = Number(value());
        if (!(n > 0)) throw new UsageError("--mintick takes a positive number");
        a.mintick = n;
        break;
      }
      default:
        if (flag.startsWith("-") && flag.length > 1) throw new UsageError(`Unknown option ${flag}`);
        positional.push(arg);
    }
  }
  [a.command, a.file] = positional;
  if (positional.length > 2) throw new UsageError(`Unexpected ${positional.slice(2).join(" ")}`);
  return a;
}

const line = (i: Issue) => `  line ${i.line}: ${i.message}`;

function describe(c: Converted): string {
  const kind = c.library ? `library ${c.libraryName ?? ""}`.trim() : c.code.includes("P.strategy") ? "strategy" : "indicator";
  return `${c.name ?? "script"} (${kind}${c.overlay ? ", on the price chart" : ""})`;
}

/** Notes for the screen: what stopped it, and what was left out. */
function report(c: Converted): string {
  const parts: string[] = [];
  if (c.missingLibraries.length) parts.push(`It imports ${c.missingLibraries.join(", ")}: pass each with --lib <file.pine>.`);
  if (c.errors.length) parts.push(`Not converted: ${c.errors.length} to address\n${c.errors.map(line).join("\n")}`);
  if (c.warnings.length) parts.push(`Left out, with the reason (${c.warnings.length})\n${c.warnings.map(line).join("\n")}`);
  return parts.join("\n\n");
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (a.version) {
    io.out(`${io.version}\n`);
    return 0;
  }
  if (a.help || !a.command) {
    io.out(HELP);
    return a.help ? 0 : 2;
  }
  if (!["convert", "check", "run", "parity"].includes(a.command)) {
    io.err(`Unknown command "${a.command}"\n\n${HELP}`);
    return 2;
  }
  if (!a.file) {
    io.err(`alpharesin ${a.command} needs a script file\n`);
    return 2;
  }
  if (a.command === "run" && !a.bars) {
    io.err("alpharesin run needs --bars <file.csv>\n");
    return 2;
  }
  if (a.command === "parity" && !a.tv) {
    io.err("alpharesin parity needs --tv <export.csv>\n");
    return 2;
  }

  try {
    const source = io.readFile(a.file);
    const libraries = a.libs.map((f) => ({ source: io.readFile(f) }));
    const c = convert(source, { libraries, host: "the host" });
    const emit = (text: string) => (a.out ? io.writeFile(a.out, text) : io.out(text));

    if (a.command === "convert" || a.command === "check") {
      if (a.json) {
        const { code, ...rest } = c;
        io.out(JSON.stringify(a.command === "convert" ? { ...rest, code } : rest, null, 2) + "\n");
        return c.ok ? 0 : 1;
      }
      const notes = report(c);
      if (a.command === "check") {
        io.out(`${c.ok ? "Converts" : "Doesn't convert yet"}: ${describe(c)}\n${notes ? `\n${notes}\n` : ""}`);
        return c.ok ? 0 : 1;
      }
      if (!c.ok) {
        io.err(`${notes}\n`);
        return 1;
      }
      emit(c.code);
      if (notes) io.err(`${notes}\n`);
      if (a.out) io.err(`Wrote ${a.out}: ${describe(c)}\n`);
      return 0;
    }

    if (!c.ok || c.library) {
      io.err(c.library ? "A library has nothing to run on its own: run a script that imports it, with --lib.\n" : `${report(c)}\n`);
      return 1;
    }
    const mod = await io.load(c.code);
    const inputs = resolveInputs(mod, a.inputs);

    if (a.command === "run") {
      const file = parseBars(io.readFile(a.bars!));
      const r = runScript(mod, file.bars, { inputs, periodMs: file.periodMs, mintick: a.mintick ?? file.tick, ...(a.symbol ? { symbol: a.symbol } : {}) });
      if (a.json) emit(JSON.stringify({ name: mod.default.name, inputs, columns: r.columns, strategy: r.strategy }, null, 2) + "\n");
      else emit(columnsCsv(file.bars, r.columns));
      if (!a.json && r.strategy) {
        const s = r.strategy;
        io.err(`${mod.default.name}: ${s.trades} closed trades, net ${s.netProfit.toFixed(2)} (${s.netProfitPct.toFixed(2)}%), profit factor ${s.profitFactor === null ? "-" : s.profitFactor.toFixed(2)}\n`);
      }
      if (c.warnings.length && !a.json) io.err(`${report(c)}\n`);
      return 0;
    }

    // parity
    const tv = parseTvCsv(io.readFile(a.tv!));
    const r = runScript(mod, tv.bars, { inputs, periodMs: tv.periodMs, mintick: a.mintick ?? tv.tick, ...(a.symbol ? { symbol: a.symbol } : {}) });
    const p = compareParity(tv.columns, r.columns);
    if (a.json) emit(JSON.stringify(p, null, 2) + "\n");
    else {
      const rows = p.columns.map((col) => {
        const detail =
          col.status === "match"
            ? "every bar"
            : col.status === "warmup"
              ? `from bar ${col.from! + 1} of ${col.compared}`
              : col.status === "converging"
                ? `still settling, ${(col.lastDiff * 100).toPrecision(2)}% apart at the end`
                : col.status === "missing"
                  ? "not in the export"
                  : `${col.equal} of ${col.compared} bars agree${col.example ? `; bar ${col.example.index + 1}: TradingView ${col.example.tv}, AlphaResin ${col.example.ours}` : ""}`;
        return `  ${col.status.padEnd(10)} ${col.title}: ${detail}`;
      });
      const ignored = p.ignored.length ? `\nIn the export but not plotted by this script: ${p.ignored.join(", ")}` : "";
      emit(`${p.verdict === "match" ? "Matches" : p.verdict === "partial" ? "Partly matches" : "Differs from"} TradingView on ${p.bars} bars\n${rows.join("\n")}${ignored}\n`);
    }
    return p.verdict === "match" ? 0 : 1;
  } catch (e) {
    if (e instanceof RunError || e instanceof ParityError || e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return e instanceof UsageError ? 2 : 1;
    }
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      io.err(`No such file: ${err.path ?? ""}\n`);
      return 2;
    }
    io.err(`${err?.message ?? String(e)}\n`);
    return 1;
  }
}
