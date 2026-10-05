# Conformance scripts

Each script plots many built-ins on one chart. Export it once from
TradingView and AlphaResin compares every column with its own run of the same
script on the same bars.

| Script | What it covers |
|---|---|
| `1-averages-oscillators.pine` | Moving averages, oscillators, volatility, bands, MACD, DMI |
| `2-trend-volume-pivots.pine` | Supertrend, SAR, VWAP, volume series, pivots, pivot point levels, other timeframes, Heikin Ashi, time |
| `3-strategy.pine` | The broker: entries, an ATR bracket, a trailing stop, commission and sizing |

## Exporting one

1. Open a chart of a liquid market on the 1-hour timeframe, for example BTCUSD.
2. Add the **Volume** indicator. The export only carries volume when it's on the chart.
3. Open a new Pine editor tab, paste the script, and add it to the chart.
4. Scroll back until the chart has loaded at least 2,000 bars, so the slow averages settle.
5. Open the chart's menu and choose **Export chart data**. Keep the default time format.
6. Save the file under the script's name with `.csv`, for example `1-averages-oscillators.csv`, in `conformance/exports/`.

The exports are TradingView's data: keep them to yourself, never commit them to a public repository. Run the comparison with:

```bash
npx vitest run packages/resin/src/conformance.compare.test.ts --silent=false
```

Each column reads `match`, `warmup` (agrees once the script has enough history), `converging` (still settling at the end), `differs` (with the first bar that differs) or `missing`.
