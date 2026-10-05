# Conformance results

## 5 October 2026

The three conformance scripts were run on TradingView and exported:
- **Chart:** BTCUSD, 1 hour, 3,266 bars from 22 May to 5 October 2026.
- **Run:** AlphaResin ran the same scripts on the exports' own bars and compared
  every column. The exports were then deleted.

**Outcome: every compared column matches TradingView.**
- 106 columns match exactly, once each has the history it needs.
- One settles to within 0.002% because the export holds only 19 weeks of
  weekly history.

### 1. Averages, oscillators and volatility: 54 of 54 match

- **Averages:**
  - `ta.sma`, `ema`, `rma`, `wma`, `hma`, `vwma`, `swma`, `linreg`;
  - `ta.alma` (with and without `floor`).
- **Statistics:**
  - `ta.median`, `stdev` (biased and not), `dev`, `variance`;
  - `ta.percentrank`, `percentile_linear_interpolation`, `percentile_nearest_rank`, `mode`.
- **Oscillators:**
  - `ta.cmo`, `mom`, `roc`, `rsi`, `cci`, `mfi`, `wpr`, `tsi`, `rci`, `cog`;
  - `ta.stoch`, `macd` (3 lines), `dmi` (3 lines).
- **Ranges:**
  - `ta.change`, `highest`, `lowest`, `highestbars`, `lowestbars`, `range`;
  - `ta.atr`, `tr`, `tr(true)`.
- **Bands:** `ta.bb` (3), `bbw`, `kc` (3), `kcw`.
- **Cumulative:** `ta.cum`, matched bar by bar (see *Compared by its steps* below).

### 2. Trend, volume, pivots and other timeframes: 45 of 45 (44 exact, 1 settling)

- **Trend:** `ta.supertrend` (value and direction), `ta.sar`.
- **VWAP:**
  - `ta.vwap`, anchored to each day;
  - `ta.vwap(hlc3, anchor, 1)`, weekly with bands.
- **Volume:**
  - `ta.obv`, `accdist`, `pvt`, `wad`, `pvi`, `nvi`, `max`, `min`: each matched bar by bar;
  - `ta.iii`, `wvad`, `correlation`.
- **Signals:**
  - `ta.barssince`, `valuewhen`;
  - `ta.pivothigh`, `pivotlow`;
  - `ta.crossunder`, `rising`, `falling`.
- **Pivot point levels:** `ta.pivot_point_levels`, for Traditional,
  Fibonacci, Woodie, Classic, DM and Camarilla.
- **Other timeframes:**
  - `request.security` on the daily timeframe, with and without lookahead;
  - weekly EMA (settling, as above);
  - Heikin Ashi close.
- **Time:** `dayofweek`, `time("D")`.

### 3. The broker: every bar matches

Entries on EMA crosses, an ATR bracket on longs and a trailing stop on shorts.
- **Lining up:** TradingView's strategy starts long before the export, so the
  two are lined up at the first bar both are flat after the averages settle
  (bar 301), with the same equity there.
- **What matches:** from then on, every bar's position, average price, net
  profit, equity, open profit and closed, won and lost trades match.
- **Not compared:** maximum drawdown, which depends on TradingView's whole
  history.

The exports showed six rules of TradingView's broker, which AlphaResin now follows:
1. **Size.** An order sized as a percent of equity uses the equity and close
   of the bar that placed it. It leaves room for the percent commission, and
   is rounded down to a millionth of a unit.
2. **Entry commission.** An entry's commission leaves net profit when the
   trade opens.
3. **Rounding.** Order prices are rounded to the tick in the direction that
   makes them harder to reach:
   - a sell limit rounds up, a sell stop rounds down;
   - a buy limit rounds down, a buy stop rounds up.
4. **Whole ticks.** Distances given in ticks are whole ticks.
5. **Trail restarts.** A trailing stop given new terms starts over.
6. **Trail at the open.** A trail can start at a bar's open.

### Two corrections this round found

- **`ta.iii`:** the range position times volume. AlphaResin had divided by volume.
- **`ta.percentile_linear_interpolation`:** each value sits at the middle of
  its rank (position p·n − 0.5).

### Compared by its steps

TradingView computes cumulative series from the start of its own history,
which is longer than any export:
- `cum`, `obv`, `accdist`, `pvt` and `wad`: each bar's change is compared;
- `pvi` and `nvi`: each bar's ratio;
- `max` and `min`: TradingView's value is checked to move exactly as "the
  extreme so far" does.

### Not covered by these scripts

The rest of the language is covered by unit tests against definitions
written out in the tests, not yet by TradingView exports:
- `array.*`, `matrix.*`, `map.*` and `str.*`;
- drawings and tables;
- lower timeframes and other markets;
- libraries.

A further conformance script can bring any of these in.
