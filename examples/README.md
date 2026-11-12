# Examples

Two short indicators, written from public, textbook formulas, and bars to run
them on.

| File | What it is |
|---|---|
| `sma-cross.pine` | Two simple moving averages, markers where they cross, and two alert conditions |
| `rsi.pine` | Wilder's relative strength index with an upper and a lower level, and a tinted background beyond them |
| `bars.csv` | 80 daily bars from 5 January 2026. **Synthetic**: a seeded random walk, not market data |

From the folder that holds `examples/` (the repository's root):

```sh
npx alpharesin check examples/sma-cross.pine
npx alpharesin convert examples/sma-cross.pine -o sma-cross.js
npx alpharesin run examples/rsi.pine --bars examples/bars.csv -o rsi.csv
```

The npm package carries this folder too. After `npm install alpharesin`, copy
it beside you with `cp -R node_modules/alpharesin/examples .` and run the
commands above.
