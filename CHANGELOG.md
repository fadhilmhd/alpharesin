# Changelog

Every published version of the `alpharesin` package, newest first. Versions
follow [semantic versioning](https://semver.org/); while the version is 0.x,
a minor version can change the API.

## 0.1.7 (2026-11-12)

The runtime's built-ins match chart exports in more edge cases (ties and `na`
neighbours), and the project gains its documentation and examples. The
comparisons behind these changes, and their scope, are in
[RESULTS.md](https://github.com/fadhilmhd/alpharesin/blob/main/packages/resin/conformance/RESULTS.md).

**Runtime (`pine`, `ta`)**
- `ta.ema` and `ta.rma` now use the step order that matched exported values
  bit for bit (daily and hourly exports): `prev + α·(x − prev)` and
  `(prev·(L − 1) + x) / L`. Values can change in the last bits, which decides
  ties, for example between two equal pivots. `ta.rsi`, `ta.macd`, `ta.atr`,
  `ta.supertrend` and `ta.dmi` use the same steps.
- In comparisons with chart exports, Pine's float comparisons treated values
  within a tolerance between 1.03e-11 and 1.13e-6 as equal; the runtime uses
  1e-10. `ta.dmi` now applies it (an internal helper, not part of the API): an
  up-move and a down-move equal to within that tolerance are a tie, and
  neither counts as directional movement.
- `ta.pivothigh` and `ta.pivotlow`: an `na` neighbour no longer stops a pivot,
  so a series' first value can be one.
- `ta.median` on a whole series (the `ta` API) keeps its window sorted as it
  slides: the same values, in a fraction of the time on long windows.
  `ta.median` in a converted script gives the same values as before, at the
  same speed.

**Command line and library**
- `alpharesin parity`:
  - names the first bar where a column differs (it named the last), with the
    bar's time;
  - `maxDiff` in `--json` is the largest relative difference,
    |a − b| / max(1, |a|, |b|) (it read 0 before). For a column that matches
    to the end, it is measured from where it matches; for any other, over
    every compared bar;
  - a column with a few bars that differ among exact ones is `differs`, even
    when its last bars are exact. Before, such a column could be called
    `converging` and the run a match; `converging` now needs a gap on nearly
    every bar that shrinks toward the end;
  - the text says the run matches, partly matches or differs from "the chart
    export", the file it compared.
- `alpharesin run -o` says what it wrote (bars and columns), as `convert -o`
  does.
- `alpharesin check` on a script that doesn't parse names it from its
  declaration (it printed an empty name).

**Documentation and repository**
- README: claims scoped to what has been checked, the shape of `columns`
  (`{ title, values }`), code examples that run as written, how to get the
  examples after `npm install`, building from source, the version's status
  and badges.
- New: this changelog, SECURITY.md, and `examples/` (two scripts and synthetic
  bars). The npm package carries them, and CLEAN-ROOM.md, so the README's
  links work from `node_modules`; links to files the package doesn't carry
  go to the repository.
- NOTICE: the empty attributions line is gone; Pine Script® carries its mark.
- A lockfile, `npm ci` in the workflows, and a CI job that runs the package
  on Node 18.

**Known limits**
- Comparisons written in a converted script (`>=`, `==` and the others) still
  compare floats exactly; the 1e-10 tolerance applies only inside the
  built-ins above.

## 0.1.6 (2026-10-07)

- `ta.percentile_nearest_rank` ranks over the whole window, with `na` ranked
  lowest, as TradingView does.
- `ta.pivothigh` and `ta.pivotlow` resolve ties as TradingView does: an equal
  value on the left doesn't stop a pivot, an equal value on the right does,
  so of two equal highs the later one is the pivot.

## 0.1.5 (2026-10-07)

- `input.timeframe` converts to a timeframe input the user can change (the
  SDK's text input with `timeframe: true`); `timeframe.period` reads as the
  chart's own, and `request.security` reads the timeframe picked.
- The command line refuses an `--input` value that isn't a timeframe; the
  playground offers a list.

## 0.1.4 (2026-10-07)

- The SDK's `Sdk` interface (`version`, `ta`, `nz`, `clamp`, `na`, `pine`), so
  a module's `run(ctx, sdk)` is type-checked; the runner hands modules that
  object.
- A converted module carries a description.
- The published type declarations load under TypeScript's `node16` and
  `nodenext` module resolution.

## 0.1.3 (2026-10-06)

- README: why the output is JavaScript.

## 0.1.2 (2026-10-06)

- `input.string` (without options), `input.symbol` and `input.text_area`
  convert to text inputs the user can change.
- `--input` splits on the last `=`, so labels that contain one
  (`"Strike (0 = auto)=5"`) work.

## 0.1.1 (2026-10-05)

- The `alpharesin` command installs: the package's `bin` path is written as
  npm expects it.

## 0.1.0 (2026-10-05)

The first version on npm:
- the converter (`convert`), the runner (`parseBars`, `loadModule`,
  `runScript`) and the Pine runtime (`pine`, `ta`) in one package, with types;
- the `alpharesin` command: `check`, `convert`, `run` and `parity`;
- the playground in the browser.
