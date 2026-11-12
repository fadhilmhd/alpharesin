# AlphaResin

[![CI](https://github.com/fadhilmhd/alpharesin/actions/workflows/ci.yml/badge.svg)](https://github.com/fadhilmhd/alpharesin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/alpharesin.svg)](https://www.npmjs.com/package/alpharesin)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

**Pine in. Many forms out.**

> **Status: early (0.x).** This README describes version 0.1.7. The API, the
> command's output and what converts can change between versions; each change
> is listed in [CHANGELOG.md](CHANGELOG.md).

AlphaResin reads Pine-compatible scripts (versions 5 and 6: indicators, strategies
and libraries) and turns them into other forms. Its first form is a module
for the AlphaPine indicator SDK, which runs a script bar by bar in a browser
or in Node. More forms can follow, from anyone who needs one.

AlphaResin is an independent project. It is not affiliated with, endorsed by or
connected to TradingView. Pine Script® is a trademark of TradingView, Inc.
How AlphaResin is written, and from what, is in [CLEAN-ROOM.md](CLEAN-ROOM.md).

## The name

A pine tree makes resin. People have long made many things from it:
- turpentine, distilled from it;
- rosin, for violin bows and dancers' shoes;
- varnish and incense;
- given enough time, amber.

One raw material, shaped into many products.

That is the idea here. A Pine script is the raw material, and AlphaResin is what
you shape it from. Today it becomes an indicator that runs, can be measured and
can be compared with a chart export. Tomorrow it could become Python for
research, a backtest in another engine, or a language nobody has asked for yet.

"Alpha" comes from AlphaPine, where AlphaResin began: the resin of the AlphaPine.

## Use it

**In the browser:** the [playground](https://fadhilmhd.github.io/alpharesin/).
Paste a script and see what converts, what is left out and why, and the module
it becomes. Run it on sample bars or your own CSV. Nothing leaves the page.

**On the command line** (Node 18 or newer, nothing else to install). The
[`examples/`](examples/) folder holds two short scripts and a file of synthetic
bars. The commands below run from a folder that has it: a clone of this
repository, or, after `npm install alpharesin`, a copy of the package's own
(`cp -R node_modules/alpharesin/examples .`).

```sh
npx alpharesin check examples/sma-cross.pine                          # what converts, what is left out, by line
npx alpharesin convert examples/sma-cross.pine -o sma-cross.js         # the module
npx alpharesin run examples/rsi.pine --bars examples/bars.csv -o rsi.csv  # every plot, bar by bar, as CSV
```

To compare a script with a chart you exported yourself (TradingView's
**Export chart data**, with the script on the chart):

```sh
npx alpharesin parity <script.pine> --tv <export.csv>
```

- `--lib Library.pine` supplies a library the script imports; repeat it for each one.
- `--input "Length=20"` sets an input by its name or label.
- `--json` gives machine-readable output.
- A bars file needs `time, open, high, low, close` and optionally `volume`, in UTC.
- `alpharesin --help` lists everything.

For regular use, install it: `npm install -g alpharesin`.

**From code** (an ES module, Node 18 or newer):

```sh
npm install alpharesin
```

```js
// example.mjs: run it with `node example.mjs` beside the examples/ folder.
import { readFileSync } from "node:fs";
import { convert, loadModule, parseBars, runScript } from "alpharesin";

const pineSource = readFileSync("examples/sma-cross.pine", "utf8");
const csvText = readFileSync("examples/bars.csv", "utf8");
// Libraries the script imports, if any: [{ source: readFileSync("MyLibrary.pine", "utf8") }].
const libraries = [];

const { ok, code, errors, warnings } = convert(pineSource, { libraries });
// ok: it converted. code: an SDK module (JavaScript) to run.
// errors: what stopped it, each with its line. warnings: what it left out, and why.
if (!ok) throw new Error(errors.map((e) => `line ${e.line}: ${e.message}`).join("\n"));
for (const w of warnings) console.log(`left out, line ${w.line}: ${w.message}`);

const mod = await loadModule(code);
const bars = parseBars(csvText);
const { columns, strategy } = runScript(mod, bars.bars, { periodMs: bars.periodMs, mintick: bars.tick });
// columns: one { title, values } per plot, one value per bar (null where the plot is na).
// strategy: a strategy's results, or null for an indicator.
for (const { title, values } of columns) console.log(title, values.at(-1));
```

Everything ships in the one package, `alpharesin`: the converter, the Pine
runtime that converted modules run on (`pine`, `ta`), the SDK's TypeScript
types, and the `alpharesin` command. The `packages/` folders in this
repository (`resin`, `engine`, `sdk`) are its parts; they are not published
on their own.

## What it does

- **It parses Pine v5 and v6.** The lexer and parser handle:
  - Pine's indentation and line wrapping;
  - user functions with overloads, methods, user types, enums;
  - arrays, maps, matrices;
  - `if`, `switch`, `for`, `for … in` and `while`, as statements and as
    expressions.

  Something it can't parse is an error with its line, never a guess.
- **It converts what a script means.** The result runs on a Pine runtime
  (`packages/engine`) written from Pine's public documentation:
  - series and their history;
  - each `ta.*` call with its own state;
  - `na` handling;
  - `request.security` across timeframes, with lookahead and gaps;
  - drawings;
  - strategies, through a broker emulator.

  A converted script can still behave differently from the original. Where the
  runtime has been compared with TradingView, the results and their scope are
  in [conformance/RESULTS.md](https://github.com/fadhilmhd/alpharesin/blob/main/packages/resin/conformance/RESULTS.md).
- **It says what it did.**
  - A construct it doesn't support is an error, with its line.
  - A part with no place in the host is left out with a note and its line.
  - Some presentation-only arguments (such as text sizes) are accepted and
    ignored without a note; they change how something looks, not its values.
- **It can be checked.** Export a chart with the script on it, and
  `alpharesin parity` compares its own run with the export, plot by plot, on
  the export's own bars.

## How it works

```
Pine source
   │  lexer        tokens, Pine's blocks and line wrapping
   ▼
   │  parser       a syntax tree for the v5/v6 grammar (src/ast.ts)
   ▼
   │  linker       imported libraries joined in (src/link.ts)
   ▼
   │  target       today: an AlphaPine SDK module (src/convert.ts)
   ▼
A module that runs on the Pine runtime (packages/engine)
```

The syntax tree is where every target starts. A target for another language
walks the same tree. [CONTRIBUTING.md](https://github.com/fadhilmhd/alpharesin/blob/main/CONTRIBUTING.md) explains how to add one.

## Why the output is JavaScript

Pine is a good language for an indicator on TradingView's chart. It was made
for that chart, and away from it, it has limits:

- **It runs in one place.** Pine's compiler and runtime are TradingView's, and
  scripts run on TradingView's servers. A script can't run in your own app, in
  a test, in a backtest engine you choose, or offline.
- **Its output describes a chart.** `plot`, `label` and `table` say what to
  draw on TradingView's chart. A host that wants to measure a signal, alert on
  an event or explain a reading has to guess what the drawing meant.
- **It is a closed box.** A script can't read files or run unit tests, loops,
  drawings and requests have limits, and its data comes from TradingView.

AlphaResin keeps Pine as the input, so existing scripts and what people know
about Pine still count. The output is a plain JavaScript ES module, written
against a small typed contract, the AlphaPine SDK:

```js
export default {
  name: "RSI",
  description: "Relative strength index, 0 to 100.",
  inputs: { length: { type: "int", default: 14 } },
  run({ close, inputs }, { ta }) {
    return { lines: [{ title: "RSI", values: ta.rsi(close, inputs.length) }] };
  },
};
```

What that gives:

- **It runs wherever JavaScript runs.** Browsers, Node and other runtimes need
  nothing installed.
- **It is a whole language.** You get objects, classes, maps, recursion, any
  algorithm, and npm. A converted script can be opened and extended by hand.
- **The output is data, not drawing.** Lines, markers, zones, events, tables
  and a bias come back as values, and each host decides how to show them.
  Events can be counted, measured and backtested.
- **It can be tested.** Run a converted script on a CSV (`alpharesin run`),
  compare it with a chart export (`alpharesin parity`), or unit-test any
  module, hand-written or converted, with a test runner. (`run` and `parity`
  take the Pine script and convert it themselves.)
- **Tools already know it.** Editors, type checkers and AI assistants all read
  JavaScript and TypeScript, and the package carries the SDK's types.
- **Pine's behaviour lives in the runtime, not the language.** Series history,
  each `ta.*` call's own state, `na` and `request.security` are handled by the
  runtime, so the module stays plain JavaScript.

### Other routes to the same place

Two other approaches are reasonable too:

- **Run Pine's syntax as it is**, with an interpreter or transpiler written in
  JavaScript. It feels familiar, but the script stays inside Pine's model: its
  output still describes a chart, and extending it means writing more Pine.
- **Design a new Pine-like language.** It can lift Pine's limits, but everyone
  has to learn it, and its editors, documentation and tools start from nothing.

AlphaResin takes a third route: Pine goes in and a language that already exists
comes out. Nobody has to learn anything new to start, and nothing stops them
from going further.

### What it costs

- For the simplest indicators, a hand-written module is longer than Pine. The
  calls read the same (`ta.ema(close, 9)`), but the module's frame (name,
  inputs, return) is spelled out.
- Converted code reads like generated code. Edit the Pine and convert it again,
  or rewrite the parts you care about.
- JavaScript isn't sandboxed by itself. A host must isolate the code it runs,
  for example in a worker with no network and a time limit, as the AlphaPine
  Terminal does.

## What converts today

- **Built-ins:**
  - the namespaces: `ta.*`, `math.*`, `str.*`, `color.*`, `array.*`, `map.*`, `matrix.*`;
  - `timeframe.*`, `syminfo.*`, `chart.point`;
  - time and date functions.
- **Data:**
  - `request.security` on the same market, on higher and lower timeframes,
    including one the user picks through `input.timeframe`;
  - `request.security` on other markets the host supplies;
  - `request.security` on Heikin Ashi bars;
  - `request.security_lower_tf`.
- **Strategies:**
  - orders: `strategy.entry`, `order`, `close`, `close_all`, `exit` and `cancel`;
  - fills on the next open or on the close;
  - targets, stops and trailing stops along each bar;
  - reversals, pyramiding, sizing and commission.

  Entries become events, and the strategy's own results come out in the
  figures a strategy report lists (trades, net profit, profit factor and more).
- **Libraries:** `import user/Name/N` reads a library from the sources given to
  `convert`. A library script also converts on its own.
- **Output:**
  - plots, shapes, chars and arrows;
  - levels and fills;
  - background and candle colours;
  - alert conditions, as events;
  - labels, lines, boxes, polylines and line fills;
  - tables.

An internal measurement, not reproducible from this repository (October 2026,
on 3,003 publicly shared scripts that are their authors' work and are not
redistributed here): about 86% of the indicators converted, and about 90% of
the strategies. Most of the rest imported libraries that weren't supplied,
used data no host carries, or weren't valid Pine.

## The host decides what fits

A script written for TradingView's chart meets a host with its own design.
AlphaResin converts what fits the host and leaves out the rest, each time with a
note. In the AlphaPine Terminal:

| In the Pine script | In the Terminal |
|---|---|
| `table.*` | Shown beside the chart, in the indicator's window |
| `bgcolor`, `barcolor` | A tinted background behind each bar; tinted candles |
| `alertcondition`, strategy entries | Events the Terminal measures, alerts on and backtests |
| Financial, economic and footprint data | `na`: the Terminal doesn't carry it |
| Renko, Kagi and other chart types | The market's regular bars |
| Text sizes, frames and other presentation | Left out |

## Checking against a chart export

- `packages/resin/src/parity.ts` reads a TradingView **Export chart data** file and compares
  every plotted column with AlphaResin's run of the same script. Each column is
  reported as one of:
  - `match`;
  - `warmup` (agrees once there's enough history);
  - `converging` (off on nearly every bar, by less and less toward the end:
    still settling);
  - `differs`, with the first bar where it does. A few bars that differ among
    exact ones are `differs`, even when the last bars are exact.

  `maxDiff` in `--json` is the largest relative difference,
  |a − b| / max(1, |a|, |b|). The text output numbers bars from 1 and gives
  each one's time; the JSON's `index` and `from` count from 0.
- `packages/resin/conformance/` holds three scripts that plot many built-ins, so those
  built-ins can be checked from three exports
  ([conformance/README.md](https://github.com/fadhilmhd/alpharesin/blob/main/packages/resin/conformance/README.md)).
- **What has been checked:** on one chart (BTCUSD, 1 hour, 3,266 bars, October
  2026), 106 compared columns matched once each had the history it needs, and
  one settled to within 0.002%. The runtime changes in 0.1.7 (`ta.ema` and
  `ta.rma` step order, the comparison tolerance, pivots beside `na`) were
  checked on daily and hourly exports of a second chart. Arrays, maps,
  matrices, strings, drawings, tables, lower timeframes, `request.security`
  on other markets, and libraries are covered by unit tests only. Details: [conformance/RESULTS.md](https://github.com/fadhilmhd/alpharesin/blob/main/packages/resin/conformance/RESULTS.md).
- Exported chart data is the data provider's: follow its terms when you use
  it, and don't publish it.

## Build from source

Building and testing need Node 22 or newer (the package itself runs on Node 18
or newer).

```sh
git clone https://github.com/fadhilmhd/alpharesin.git
cd alpharesin
npm ci
npm run typecheck && npm test
npm run build                             # the package (packages/resin/dist/npm) and the playground
node packages/resin/dist/npm/cli.js check examples/rsi.pine
npm pack ./packages/resin/dist/npm        # alpharesin-<version>.tgz, as npm would publish it
```

`npm run build -- npm` or `npm run build -- playground` builds one of the two;
`npm run playground` serves the playground at http://localhost:4330.

## Contributing

New targets, built-ins, fixes and test scripts are all welcome. Every
contribution stays credited to the person who made it. Read
[CONTRIBUTING.md](https://github.com/fadhilmhd/alpharesin/blob/main/CONTRIBUTING.md) first; it's short. Security issues go by
email, not as issues: see [SECURITY.md](SECURITY.md).

## Licence

Apache License 2.0. See `LICENSE` and `NOTICE`. Contributions are accepted
under the same licence, and each contributor keeps the copyright to their work.
