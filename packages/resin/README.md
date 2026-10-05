# AlphaResin

**Pine in. Many forms out.**

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
you shape it from. Today it becomes an indicator that runs, is measured and
is checked against TradingView. Tomorrow it could become Python for
research, a backtest in another engine, or a language nobody has asked for yet.

"Alpha" comes from AlphaPine, where AlphaResin began: the resin of the AlphaPine.

## Use it

**In the browser:** the [playground](https://fadhilmhd.github.io/alpharesin/).
Paste a script and see what converts, what is left out and why, and the module
it becomes. Run it on sample bars or your own CSV. Nothing leaves the page.

**On the command line** (Node 18 or newer, nothing else to install):

```sh
npx alpharesin check script.pine                    # what converts, what is left out, by line
npx alpharesin convert script.pine -o script.js     # the module
npx alpharesin run script.pine --bars bars.csv      # every plot, bar by bar, as CSV
npx alpharesin parity script.pine --tv export.csv   # against a TradingView chart export
```

- `--lib Library.pine` supplies a library the script imports; repeat it for each one.
- `--input "Length=20"` sets an input by its name or label.
- `--json` gives machine-readable output.
- A bars file needs `time, open, high, low, close` and optionally `volume`, in UTC.
- `alpharesin --help` lists everything.

For regular use, install it: `npm install -g alpharesin`.

**From code:**

```sh
npm install alpharesin
```

```ts
import { convert, loadModule, parseBars, runScript } from "alpharesin";

const { ok, code, errors, warnings } = convert(pineSource, { libraries });
// ok: it converted. code: an SDK module (JavaScript) to run.
// errors: what stopped it, each with its line. warnings: what it left out, and why.

const mod = await loadModule(code);
const { columns, strategy } = runScript(mod, parseBars(csvText).bars);
// columns: each plot by title, one value per bar. strategy: its results, for a strategy.
```

The package carries the converter, the Pine runtime that converted modules run
on (`pine`, `ta`), the SDK's types, and the `alpharesin` command.

- **It reads the whole language.** The lexer and parser cover the v5 and v6
  grammar:
  - Pine's indentation and line wrapping;
  - user functions with overloads, methods, user types, enums;
  - arrays, maps, matrices;
  - every control-flow form.
- **It converts what a script means.** The result runs on the SDK's Pine
  runtime (`@alphapine/engine`), which follows TradingView's documented
  behaviour:
  - series and their history;
  - each `ta.*` call with its own state;
  - `na` handling;
  - `request.security` across timeframes, with lookahead and gaps;
  - drawings;
  - strategies, through a broker emulator.
- **It says what it did.** Nothing is silently dropped:
  - a construct the language doesn't have is an error, with its line;
  - a part with no place in the host is left out with a note.
- **It can be checked.** Export the chart from TradingView, and AlphaResin compares
  its own run with the export, plot by plot, on the export's own bars.

## How it works

```
Pine source
   │  lexer        tokens, Pine's blocks and line wrapping
   ▼
   │  parser       a syntax tree for the whole v5/v6 grammar (src/ast.ts)
   ▼
   │  linker       imported libraries joined in (src/link.ts)
   ▼
   │  target       today: an AlphaPine SDK module (src/convert.ts)
   ▼
A module that runs on @alphapine/engine's Pine runtime
```

The syntax tree is where every target starts. A target for another language
walks the same tree. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to add one.

## What converts today

- **Built-ins:**
  - the namespaces: `ta.*`, `math.*`, `str.*`, `color.*`, `array.*`, `map.*`, `matrix.*`;
  - `timeframe.*`, `syminfo.*`, `chart.point`;
  - time and date functions.
- **Data:**
  - `request.security` on the same market, on higher and lower timeframes;
  - `request.security` on other markets the host supplies;
  - `request.security` on Heikin Ashi bars;
  - `request.security_lower_tf`.
- **Strategies:**
  - orders: `strategy.entry`, `order`, `close`, `close_all`, `exit` and `cancel`;
  - fills on the next open or on the close;
  - targets, stops and trailing stops along each bar;
  - reversals, pyramiding, sizing and commission.

  Entries become events, and the strategy's own results come out as
  TradingView's Strategy Tester lists them.
- **Libraries:** `import user/Name/N` reads a library from the sources given to
  `convert`. A library script also converts on its own.
- **Output:**
  - plots, shapes, chars and arrows;
  - levels and fills;
  - background and candle colours;
  - alert conditions, as events;
  - labels, lines, boxes, polylines and line fills;
  - tables.

Measured on 3,003 public scripts:
- **86%** of indicators convert, and **98%** of those that are AlphaResin's to
  convert. The rest import libraries that weren't supplied, use data no host
  carries, or aren't valid Pine.
- **nearly 90%** of strategies convert.

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

## Checking against TradingView

- `src/parity.ts` reads a TradingView **Export chart data** file and compares
  every plotted column with AlphaResin's run of the same script. Each column is
  reported as one of:
  - `match`;
  - `warmup` (agrees once there's enough history);
  - `converging` (still settling at the end);
  - `differs`, with the first bar where it does.
- `conformance/` holds scripts that plot the built-ins, so the whole language
  can be checked from a few exports ([conformance/README.md](conformance/README.md)).

## Packages

| Package | What it is |
|---|---|
| `@alphapine/resin` | Lexer, parser, linker, the SDK target, parity |
| `@alphapine/engine` | The Pine runtime and broker that converted scripts run on, and plain `ta` functions on arrays |
| `@alphapine/sdk` | Types: what a module is, what it receives, what it may return |

## Contributing

New targets, built-ins, fixes and test scripts are all welcome. Every
contribution stays credited to the person who made it. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first; it's short.

## Licence

Apache License 2.0. See `LICENSE` and `NOTICE`. Contributions are accepted
under the same licence, and each contributor keeps the copyright to their work.
