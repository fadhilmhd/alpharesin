/** Scripts to start from, written for the playground. */
export const SAMPLES: { name: string; source: string }[] = [
  {
    name: "Moving-average cross",
    source: `//@version=6
indicator("Moving-average cross", overlay = true)

fastLength = input.int(9, "Fast length", minval = 1)
slowLength = input.int(21, "Slow length", minval = 2)

fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)

plot(fast, "Fast", color.teal, 2)
plot(slow, "Slow", color.orange, 2)

plotshape(ta.crossover(fast, slow), "Cross up", shape.triangleup, location.belowbar, color.teal)
plotshape(ta.crossunder(fast, slow), "Cross down", shape.triangledown, location.abovebar, color.red)
alertcondition(ta.crossover(fast, slow), "Cross up", "Fast crossed above slow")
`,
  },
  {
    name: "RSI with its bands",
    source: `//@version=6
indicator("RSI with its bands")

length = input.int(14, "Length", minval = 2)
upper = input.float(70, "Upper band")
lower = input.float(30, "Lower band")

r = ta.rsi(close, length)
plot(r, "RSI", color.purple)
hline(upper, "Upper", color.red)
hline(lower, "Lower", color.teal)
bgcolor(r > upper ? color.new(color.red, 85) : r < lower ? color.new(color.teal, 85) : na)
`,
  },
  {
    name: "Breakout strategy",
    source: `//@version=6
strategy("Breakout strategy", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 50, commission_type = strategy.commission.percent, commission_value = 0.1)

lookback = input.int(20, "Lookback", minval = 2)
atrLength = input.int(14, "ATR length")
stopAtr = input.float(2.0, "Stop (ATR)", step = 0.5)

top = ta.highest(high, lookback)[1]
atr = ta.atr(atrLength)

if close > top and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
strategy.exit("Stop", "Long", trail_points = stopAtr * atr / syminfo.mintick, trail_offset = stopAtr * atr / syminfo.mintick)

plot(top, "Breakout level", color.gray)
`,
  },
  {
    name: "Daily levels in a table",
    source: `//@version=6
indicator("Daily levels in a table", overlay = true)

[dHigh, dLow, dClose] = request.security(syminfo.tickerid, "D", [high[1], low[1], close[1]], lookahead = barmerge.lookahead_on)

plot(dHigh, "Yesterday's high", color.green, style = plot.style_stepline)
plot(dLow, "Yesterday's low", color.red, style = plot.style_stepline)

var t = table.new(position.top_right, 2, 3)
if barstate.islast
    table.cell(t, 0, 0, "High")
    table.cell(t, 1, 0, str.tostring(dHigh, format.mintick))
    table.cell(t, 0, 1, "Low")
    table.cell(t, 1, 1, str.tostring(dLow, format.mintick))
    table.cell(t, 0, 2, "Close")
    table.cell(t, 1, 2, str.tostring(dClose, format.mintick))
`,
  },
  {
    name: "What gets left out",
    source: `//@version=6
indicator("What gets left out")

// Financial data, footprints and chart styles have no place in every host:
// AlphaResin converts the rest and notes each one it leaves out.
eps = request.financial(syminfo.tickerid, "EARNINGS_PER_SHARE", "FQ")
poc = footprint.poc()
varip ticks = 0
ticks += 1

plot(close, "Close")
plot(eps, "EPS")
plotcandle(open, high, low, close, "Candles")
`,
  },
];
