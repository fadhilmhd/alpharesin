/**
 * The strategy broker for converted Pine strategies (strategy.*), written
 * from TradingView's public description of its broker emulator:
 * - an order placed while a bar is computed fills on the next bar's open
 *   (or on the same bar's close with process_orders_on_close);
 * - limit, stop and exit orders fill along the bar's assumed path: open, then
 *   whichever of high and low is nearer the open, then the other, then close;
 * - strategy.entry reverses an opposite position and respects pyramiding;
 *   strategy.order only adds to or takes from the position;
 * - strategy.exit brackets the open trades of one entry (or all) with a
 *   profit target, a stop loss and a trailing stop, in prices or ticks.
 * It has one bar of resolution: no bar magnifier, margin calls or risk rules.
 */

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** What the broker reads from the running script. */
export interface BrokerHost {
  readonly bars: Bar[];
  readonly i: number;
  readonly mintick: number;
}

type Side = 1 | -1;

interface Settings {
  pyramiding: number;
  qtyType: string;
  qtyValue: number;
  initialCapital: number;
  slippage: number;
  commissionType: string;
  commissionValue: number;
  onClose: boolean;
}

interface Order {
  id: string;
  kind: "entry" | "order" | "close" | "close_all";
  side: Side;
  qty: number;
  qtyPct: number;
  limit: number;
  stop: number;
  comment: string;
  placed: number;
}

interface Exit {
  key: string;
  id: string;
  from: string;
  qty: number;
  qtyPct: number;
  profit: number;
  limit: number;
  loss: number;
  stop: number;
  trailPrice: number;
  trailPoints: number;
  trailOffset: number;
  comment: string;
  /** Has bracketed a trade: once none of its trades are open, it's done. */
  armed: boolean;
}

interface Trade {
  entryId: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryBar: number;
  entryTime: number;
  entryComment: string;
  commission: number;
  best: number;
  worst: number;
  /** Exits that already filled for this trade, and trailing state per exit. */
  used: Set<string>;
  trail: Map<string, number>;
}

interface Closed extends Trade {
  exitId: string;
  exitPrice: number;
  exitBar: number;
  exitTime: number;
  exitComment: string;
  profit: number;
}

export interface StrategyTrade {
  side: "long" | "short";
  entryId: string;
  exitId: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  profit: number;
  profitPct: number;
}

/** The strategy's own results, as TradingView's Strategy Tester lists them. */
export interface StrategyReport {
  initialCapital: number;
  netProfit: number;
  netProfitPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgTrade: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number;
  openTrades: number;
  openProfit: number;
  commission: number;
  /** Closed trades, newest first (at most 500). */
  list: StrategyTrade[];
}

export interface Fill {
  index: number;
  /** The bar whose computation placed the order: where the signal is. */
  signal: number;
  kind: "entry" | "exit";
  side: Side;
  price: number;
  id: string;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const num = (x: unknown, d = NaN) => (isNum(x) ? x : d);
const str = (x: unknown, d = "") => (typeof x === "string" ? x : d);
const sideOf = (dir: unknown): Side => (/short/.test(String(dir)) ? -1 : 1);

export class Broker {
  enabled = false;
  private s: Settings = { pyramiding: 0, qtyType: "strategy.fixed", qtyValue: 1, initialCapital: 1_000_000, slippage: 0, commissionType: "strategy.commission.percent", commissionValue: 0, onClose: false };
  private pending: Order[] = [];
  private readonly exits = new Map<string, Exit>();
  private readonly openList: Trade[] = [];
  private readonly closedList: Closed[] = [];
  readonly fills: Fill[] = [];
  private net = 0;
  private grossP = 0;
  private grossL = 0;
  private paid = 0;
  private peak = NaN;
  private maxDD = 0;
  private maxDDPct = 0;
  private stepped = -1;
  private maxRunup = 0;
  private trough = NaN;
  private readonly maxHeld = { all: 0, long: 0, short: 0 };

  constructor(private readonly host: BrokerHost) {}

  /** `strategy(...)`'s settings; the first call wins (they're constants in Pine). */
  setup(o: Record<string, unknown>) {
    if (this.enabled) return;
    this.enabled = true;
    this.s = {
      pyramiding: Math.max(0, Math.trunc(num(o.pyramiding, 0))),
      qtyType: str(o.default_qty_type, "strategy.fixed"),
      qtyValue: num(o.default_qty_value, 1),
      initialCapital: num(o.initial_capital, 1_000_000),
      slippage: num(o.slippage, 0),
      commissionType: str(o.commission_type, "strategy.commission.percent"),
      commissionValue: num(o.commission_value, 0),
      onClose: o.process_orders_on_close === true,
    };
    this.peak = this.s.initialCapital;
  }

  // ---------- orders ----------

  entry(id: unknown, direction: unknown, qty?: unknown, limit?: unknown, stop?: unknown, _oca?: unknown, _ocaType?: unknown, comment?: unknown) {
    this.place({ id: str(id), kind: "entry", side: sideOf(direction), qty: num(qty), qtyPct: NaN, limit: this.onTick(num(limit), sideOf(direction) === 1 ? "down" : "up"), stop: this.onTick(num(stop), sideOf(direction) === 1 ? "up" : "down"), comment: str(comment), placed: this.host.i });
  }

  order(id: unknown, direction: unknown, qty?: unknown, limit?: unknown, stop?: unknown, _oca?: unknown, _ocaType?: unknown, comment?: unknown) {
    this.place({ id: str(id), kind: "order", side: sideOf(direction), qty: num(qty), qtyPct: NaN, limit: this.onTick(num(limit), sideOf(direction) === 1 ? "down" : "up"), stop: this.onTick(num(stop), sideOf(direction) === 1 ? "up" : "down"), comment: str(comment), placed: this.host.i });
  }

  close(id: unknown, comment?: unknown, qty?: unknown, qtyPct?: unknown, _alert?: unknown, immediately?: unknown) {
    const o: Order = { id: str(id), kind: "close", side: 1, qty: num(qty), qtyPct: num(qtyPct), limit: NaN, stop: NaN, comment: str(comment), placed: this.host.i };
    if (immediately === true) this.market(o, this.host.i, this.bar(this.host.i).close);
    else this.place(o);
  }

  close_all(comment?: unknown, _alert?: unknown, immediately?: unknown) {
    const o: Order = { id: "", kind: "close_all", side: 1, qty: NaN, qtyPct: NaN, limit: NaN, stop: NaN, comment: str(comment), placed: this.host.i };
    if (immediately === true) this.market(o, this.host.i, this.bar(this.host.i).close);
    else this.place(o);
  }

  exit(
    id: unknown, from?: unknown, qty?: unknown, qtyPct?: unknown, profit?: unknown, limit?: unknown, loss?: unknown, stop?: unknown,
    trailPrice?: unknown, trailPoints?: unknown, trailOffset?: unknown, _oca?: unknown, comment?: unknown,
  ) {
    const key = `${str(id)}|${str(from)}`;
    const prev = this.exits.get(key);
    // Distances in ticks are whole ticks (TradingView drops the fraction).
    const ticks = (x: unknown) => (isNum(x) ? Math.trunc(x) : NaN);
    const next: Exit = {
      key, id: str(id), from: str(from), qty: num(qty), qtyPct: num(qtyPct), profit: ticks(profit), limit: num(limit), loss: ticks(loss), stop: num(stop),
      trailPrice: num(trailPrice), trailPoints: ticks(trailPoints), trailOffset: ticks(trailOffset), comment: str(comment), armed: prev?.armed ?? false,
    };
    // A trailing stop given new terms starts over: it has to be reached again, from where the price is then.
    const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b));
    if (prev && !(same(prev.trailPrice, next.trailPrice) && same(prev.trailPoints, next.trailPoints) && same(prev.trailOffset, next.trailOffset))) {
      for (const t of this.openList) t.trail.delete(key);
    }
    this.exits.set(key, next);
  }

  cancel(id: unknown) {
    const k = str(id);
    this.pending = this.pending.filter((o) => o.id !== k);
    for (const [key, e] of this.exits) if (e.id === k) this.exits.delete(key);
  }

  cancel_all() {
    this.pending = [];
    this.exits.clear();
  }

  /** A new order with the same id (and kind) replaces the one still waiting. */
  private place(o: Order) {
    this.pending = this.pending.filter((p) => !(p.id === o.id && p.kind === o.kind));
    this.pending.push(o);
  }

  // ---------- the emulator ----------

  private bar(k: number): Bar {
    return this.host.bars[k]!;
  }

  /** Before bar `i` is computed: fill what was ordered, then walk the bar's path for limits, stops and exits. */
  step(i: number) {
    if (!this.enabled || i <= this.stepped) return;
    this.stepped = i;
    if (i > 0 && this.s.onClose) this.marketAll(i - 1, this.bar(i - 1).close);
    const b = this.bar(i);
    if (!this.s.onClose) this.marketAll(i, b.open);
    const up = Math.abs(b.high - b.open) <= Math.abs(b.open - b.low);
    const path = up ? [b.open, b.high, b.low, b.close] : [b.open, b.low, b.high, b.close];
    this.touch(i, path[0]!, path[0]!);
    for (let k = 1; k < path.length; k++) this.touch(i, path[k - 1]!, path[k]!);
    this.mark(i);
  }

  /** After the last bar: orders placed on its close fill there with process_orders_on_close. */
  finish() {
    const last = this.host.bars.length - 1;
    if (this.enabled && this.s.onClose && last >= 0) this.marketAll(last, this.bar(last).close);
  }

  private marketAll(i: number, price: number) {
    const now = this.pending.filter((o) => !isNum(o.limit) && !isNum(o.stop));
    this.pending = this.pending.filter((o) => isNum(o.limit) || isNum(o.stop));
    for (const o of now) this.market(o, i, price);
  }

  /**
   * An order price on the market's price step, rounded the way that makes it
   * harder to reach, as TradingView's fills show: a sell limit up, a sell stop
   * down, a buy limit down, a buy stop up.
   */
  private onTick(x: number, way: "up" | "down") {
    if (!isNum(x)) return x;
    const t = this.host.mintick;
    const decimals = Math.max(0, Math.min(10, Math.ceil(-Math.log10(t) - 1e-9)));
    const steps = x / t;
    const k = way === "up" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
    return Number((k * t).toFixed(decimals));
  }

  private slip(price: number, side: Side) {
    return price + side * this.s.slippage * this.host.mintick;
  }

  private fee(qty: number, price: number) {
    const v = this.s.commissionValue;
    if (!v) return 0;
    if (/cash_per_order/.test(this.s.commissionType)) return v;
    if (/cash_per_contract/.test(this.s.commissionType)) return v * qty;
    return (qty * price * v) / 100;
  }

  private get position() {
    return this.openList.reduce((s, t) => s + t.side * t.qty, 0);
  }

  private openProfitAt(price: number) {
    return this.openList.reduce((s, t) => s + t.side * (price - t.entryPrice) * t.qty, 0);
  }

  /**
   * An order's size when it names none, as TradingView's export shows it sizes
   * them: from the equity and close of the bar that placed the order, leaving
   * room for the percent commission, rounded down to a millionth of a unit.
   */
  private qtyFor(o: Order, fillPrice?: number) {
    if (isNum(o.qty) && o.qty > 0) return o.qty;
    const v = this.s.qtyValue;
    const at = fillPrice ?? this.bar(Math.max(0, Math.min(o.placed, this.host.bars.length - 1))).close;
    const floor = (q: number) => Math.floor(q * 1e6 + 1e-7) / 1e6;
    if (/percent_of_equity/.test(this.s.qtyType)) {
      const fee = /percent/.test(this.s.commissionType) ? this.s.commissionValue / 100 : 0;
      return floor(((this.s.initialCapital + this.net + this.openProfitAt(at)) * v) / 100 / (at * (1 + fee)));
    }
    if (/cash/.test(this.s.qtyType)) return floor(v / at);
    return v;
  }

  private market(o: Order, i: number, at: number) {
    switch (o.kind) {
      case "entry": {
        const pos = this.position;
        const same = pos !== 0 && Math.sign(pos) === o.side;
        if (same && this.openList.length >= Math.max(1, this.s.pyramiding)) return;
        const price = this.slip(at, o.side);
        // Sized before a reversal closes the other side: from the equity the order was placed with.
        const qty = this.qtyFor(o);
        if (pos !== 0 && !same) this.closeWhere(() => true, i, price, o.id, o.comment, NaN, NaN, o.placed);
        this.open(o, i, price, qty);
        return;
      }
      case "order": {
        const price = this.slip(at, o.side);
        let qty = this.qtyFor(o);
        const pos = this.position;
        if (pos !== 0 && Math.sign(pos) !== o.side) {
          const closing = Math.min(qty, Math.abs(pos));
          this.closeWhere(() => true, i, price, o.id, o.comment, closing, NaN, o.placed);
          qty -= closing;
        }
        if (qty > 1e-12) this.open(o, i, price, qty);
        return;
      }
      case "close":
      case "close_all": {
        const pos = this.position;
        if (pos === 0) return;
        const price = this.slip(at, pos > 0 ? -1 : 1);
        const match = o.kind === "close_all" ? () => true : (t: Trade) => t.entryId === o.id;
        this.closeWhere(match, i, price, o.kind === "close_all" ? "Close position order" : o.id, o.comment, o.qty, o.qtyPct, o.placed);
      }
    }
  }

  private open(o: Order, i: number, price: number, qty: number) {
    if (!(qty > 0)) return;
    const commission = this.fee(qty, price);
    this.paid += commission;
    // As TradingView books it: the entry's commission leaves net profit when the trade opens.
    this.net -= commission;
    this.openList.push({ entryId: o.id, side: o.side, qty, entryPrice: price, entryBar: i, entryTime: this.bar(i).time, entryComment: o.comment, commission, best: price, worst: price, used: new Set(), trail: new Map() });
    this.fills.push({ index: i, signal: o.placed, kind: "entry", side: o.side, price, id: o.id });
  }

  /** Close matching trades first in, first out: `qty` contracts, or `pct`% of them, or all. */
  private closeWhere(match: (t: Trade) => boolean, i: number, price: number, exitId: string, comment: string, qty: number, pct: number, signal: number) {
    const trades = this.openList.filter(match);
    const total = trades.reduce((s, t) => s + t.qty, 0);
    let left = isNum(qty) && qty > 0 ? Math.min(qty, total) : isNum(pct) && pct > 0 ? (total * Math.min(pct, 100)) / 100 : total;
    let side: Side | null = null;
    for (const t of trades) {
      if (left <= 1e-12) break;
      const part = Math.min(t.qty, left);
      left -= part;
      side = t.side;
      this.closePart(t, part, i, price, exitId, comment);
    }
    if (side !== null) this.fills.push({ index: i, signal, kind: "exit", side, price, id: exitId });
  }

  private closePart(t: Trade, part: number, i: number, price: number, exitId: string, comment: string) {
    const share = part / t.qty;
    const entryFee = t.commission * share;
    const exitFee = this.fee(part, price);
    this.paid += exitFee;
    const profit = t.side * (price - t.entryPrice) * part - entryFee - exitFee;
    // The entry's share of commission already left net profit when the trade opened.
    this.net += profit + entryFee;
    if (profit >= 0) this.grossP += profit;
    else this.grossL -= profit;
    this.closedList.push({ ...t, qty: part, commission: entryFee + exitFee, exitId, exitPrice: price, exitBar: i, exitTime: this.bar(i).time, exitComment: comment, profit });
    t.qty -= part;
    t.commission -= entryFee;
    if (t.qty <= 1e-12) this.openList.splice(this.openList.indexOf(t), 1);
  }

  /** One move of the bar's path, from `a` to `b` (a === b: the open itself, where gaps fill). */
  private touch(i: number, a: number, b: number) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const hit = (level: number) => isNum(level) && level >= lo && level <= hi;
    const gap = a === b;
    // Waiting limit and stop entries.
    for (const o of [...this.pending]) {
      if (!isNum(o.limit) && !isNum(o.stop)) continue;
      const long = o.side === 1;
      let price = NaN;
      if (isNum(o.stop) && (gap ? (long ? a >= o.stop : a <= o.stop) : hit(o.stop) && (long ? b >= a : b <= a))) price = gap ? a : o.stop;
      else if (isNum(o.limit) && !isNum(o.stop) && (gap ? (long ? a <= o.limit : a >= o.limit) : hit(o.limit) && (long ? b <= a : b >= a))) price = gap ? a : o.limit;
      if (!isNum(price)) continue;
      this.pending.splice(this.pending.indexOf(o), 1);
      this.market({ ...o, limit: NaN, stop: NaN }, i, isNum(o.stop) ? price : price - o.side * this.s.slippage * this.host.mintick);
    }
    // Exits on open trades.
    const tick = this.host.mintick;
    for (const t of [...this.openList]) {
      if (t.entryBar === i && gap && !this.s.onClose) continue;
      t.best = t.side === 1 ? Math.max(t.best, hi) : Math.min(t.best, lo);
      t.worst = t.side === 1 ? Math.min(t.worst, lo) : Math.max(t.worst, hi);
      for (const e of this.exits.values()) {
        if (e.from && e.from !== t.entryId) continue;
        if (t.used.has(e.key) || !this.openList.includes(t)) continue;
        e.armed = true;
        const s = t.side;
        // Exiting a long sells: its limit rounds up, its stop down; a short's the other way.
        const away = s === 1 ? "up" : "down";
        const toward = s === 1 ? "down" : "up";
        const target = this.onTick(isNum(e.limit) ? e.limit : isNum(e.profit) ? t.entryPrice + s * e.profit * tick : NaN, away);
        const stopAt = this.onTick(isNum(e.stop) ? e.stop : isNum(e.loss) ? t.entryPrice - s * e.loss * tick : NaN, toward);
        const activation = this.onTick(isNum(e.trailPrice) ? e.trailPrice : isNum(e.trailPoints) ? t.entryPrice + s * e.trailPoints * tick : NaN, away);
        let trailStop = NaN;
        if (isNum(activation) && isNum(e.trailOffset)) {
          const extreme = t.trail.get(e.key);
          if (extreme !== undefined) trailStop = this.onTick(extreme - s * e.trailOffset * tick, toward);
        }
        const favourable = s === 1 ? b >= a : b <= a;
        let price = NaN;
        if (gap) {
          if (isNum(target) && (s === 1 ? a >= target : a <= target)) price = a;
          else if (isNum(stopAt) && (s === 1 ? a <= stopAt : a >= stopAt)) price = a;
          else if (isNum(trailStop) && (s === 1 ? a <= trailStop : a >= trailStop)) price = a;
          // A bar opening past the activation level starts the trail there.
          else if (isNum(activation) && isNum(e.trailOffset) && !t.trail.has(e.key) && (s === 1 ? a >= activation : a <= activation)) t.trail.set(e.key, a);
        } else if (favourable) {
          if (hit(target)) price = target;
        } else {
          const stops = [stopAt, trailStop].filter(isNum);
          const first = s === 1 ? Math.max(...stops) : Math.min(...stops);
          if (stops.length && hit(first)) price = this.slip(first, s === 1 ? -1 : 1);
        }
        // The trailing stop follows the move once its activation level is reached.
        if (!isNum(price) && isNum(activation) && isNum(e.trailOffset) && favourable) {
          const reached = s === 1 ? hi >= activation : lo <= activation;
          if (reached || t.trail.has(e.key)) {
            const ext = t.trail.get(e.key) ?? activation;
            t.trail.set(e.key, s === 1 ? Math.max(ext, hi) : Math.min(ext, lo));
          }
        }
        if (!isNum(price)) continue;
        t.used.add(e.key);
        this.closeWhere((x) => x === t, i, price, e.id, e.comment, e.qty, e.qtyPct, i);
      }
    }
    // An exit whose trades have all closed is done.
    for (const [key, e] of this.exits) if (e.armed && !this.openList.some((t) => !e.from || t.entryId === e.from)) this.exits.delete(key);
  }

  /** Equity at the bar: the drawdown counts open trades at their worst price within it. */
  private mark(i: number) {
    const b = this.bar(i);
    const worst = this.openList.reduce((s, t) => s + t.side * ((t.side === 1 ? b.low : b.high) - t.entryPrice) * t.qty, 0);
    const base = this.s.initialCapital + this.net;
    const low = base + worst;
    if (isNum(this.peak) && this.peak - low > this.maxDD) {
      this.maxDD = this.peak - low;
      this.maxDDPct = this.peak > 0 ? (this.maxDD / this.peak) * 100 : 0;
    }
    const close = base + this.openProfitAt(b.close);
    if (!isNum(this.peak) || close > this.peak) this.peak = close;
    // Run-up: the largest rise in equity from a trough, open trades at their best within the bar.
    const best = base + this.openList.reduce((s, t) => s + t.side * ((t.side === 1 ? b.high : b.low) - t.entryPrice) * t.qty, 0);
    if (!isNum(this.trough) || low < this.trough) this.trough = low;
    this.maxRunup = Math.max(this.maxRunup, best - this.trough);
    const pos = this.position;
    this.maxHeld.all = Math.max(this.maxHeld.all, Math.abs(pos));
    if (pos > 0) this.maxHeld.long = Math.max(this.maxHeld.long, pos);
    if (pos < 0) this.maxHeld.short = Math.max(this.maxHeld.short, -pos);
  }

  // ---------- what the script reads ----------

  private get price() {
    return this.bar(Math.min(this.host.i, this.host.bars.length - 1))?.close ?? NaN;
  }
  get position_size() { return this.position; }
  get position_avg_price() {
    const q = this.openList.reduce((s, t) => s + t.qty, 0);
    return q > 0 ? this.openList.reduce((s, t) => s + t.entryPrice * t.qty, 0) / q : NaN;
  }
  get position_entry_name() { return this.openList[0]?.entryId ?? ""; }
  get opentrades() { return this.openList.length; }
  get closedtrades() { return this.closedList.length; }
  get wintrades() { return this.closedList.filter((t) => t.profit > 0).length; }
  get losstrades() { return this.closedList.filter((t) => t.profit < 0).length; }
  get eventrades() { return this.closedList.filter((t) => t.profit === 0).length; }
  get initial_capital() { return this.s.initialCapital; }
  get netprofit() { return this.net; }
  get netprofit_percent() { return (this.net / this.s.initialCapital) * 100; }
  get grossprofit() { return this.grossP; }
  get grossloss() { return this.grossL; }
  get openprofit() { return this.openProfitAt(this.price); }
  get equity() { return this.s.initialCapital + this.net + this.openprofit; }
  get max_drawdown() { return this.maxDD; }
  get max_drawdown_percent() { return this.maxDDPct; }
  get avg_trade() { return this.closedList.length ? this.net / this.closedList.length : NaN; }
  get avg_winning_trade() { const w = this.wintrades; return w ? this.grossP / w : NaN; }
  get avg_losing_trade() { const l = this.losstrades; return l ? this.grossL / l : NaN; }
  get account_currency() { return "USD"; }
  get grossprofit_percent() { return (this.grossP / this.s.initialCapital) * 100; }
  get grossloss_percent() { return (this.grossL / this.s.initialCapital) * 100; }
  get openprofit_percent() { return (this.openprofit / this.s.initialCapital) * 100; }
  get max_runup() { return this.maxRunup; }
  get max_runup_percent() { return (this.maxRunup / this.s.initialCapital) * 100; }
  get avg_trade_percent() { return this.closedList.length ? this.closedList.reduce((s, t) => s + (t.profit / (t.entryPrice * t.qty)) * 100, 0) / this.closedList.length : NaN; }
  get avg_winning_trade_percent() { const w = this.closedList.filter((t) => t.profit > 0); return w.length ? w.reduce((s, t) => s + (t.profit / (t.entryPrice * t.qty)) * 100, 0) / w.length : NaN; }
  get avg_losing_trade_percent() { const l = this.closedList.filter((t) => t.profit < 0); return l.length ? l.reduce((s, t) => s + (t.profit / (t.entryPrice * t.qty)) * 100, 0) / l.length : NaN; }
  get max_contracts_held_all() { return this.maxHeld.all; }
  get max_contracts_held_long() { return this.maxHeld.long; }
  get max_contracts_held_short() { return this.maxHeld.short; }
  get margin_liquidation_price() { return NaN; }
  /** The order size a default \`strategy.entry\` would fill at \`price\`. */
  default_entry_qty(price: number) {
    return this.qtyFor({ id: "", kind: "entry", side: 1, qty: NaN, qtyPct: NaN, limit: NaN, stop: NaN, comment: "", placed: this.host.i }, price);
  }

  /** strategy.opentrades.<field>(n) and strategy.closedtrades.<field>(n). */
  trade(which: "open" | "closed", field: string, n: unknown): number | string {
    const list: (Trade | Closed)[] = which === "open" ? this.openList : this.closedList;
    const t = list[Math.trunc(num(n, -1))];
    if (!t) return NaN;
    const c = t as Closed;
    const exitPrice = which === "open" ? this.price : c.exitPrice;
    const profit = which === "open" ? t.side * (exitPrice - t.entryPrice) * t.qty - t.commission : c.profit;
    switch (field) {
      case "entry_price": return t.entryPrice;
      case "entry_bar_index": return t.entryBar;
      case "entry_time": return t.entryTime;
      case "entry_id": return t.entryId;
      case "entry_comment": return t.entryComment;
      case "size": return t.side * t.qty;
      case "commission": return t.commission;
      case "profit": return profit;
      case "profit_percent": return (profit / (t.entryPrice * t.qty)) * 100;
      case "max_runup": return Math.max(0, t.side * (t.best - t.entryPrice) * t.qty);
      case "max_drawdown": return Math.max(0, -t.side * (t.worst - t.entryPrice) * t.qty);
      case "exit_price": return which === "closed" ? c.exitPrice : NaN;
      case "exit_bar_index": return which === "closed" ? c.exitBar : NaN;
      case "exit_time": return which === "closed" ? c.exitTime : NaN;
      case "exit_id": return which === "closed" ? c.exitId : "";
      case "exit_comment": return which === "closed" ? c.exitComment : "";
    }
    return NaN;
  }

  report(): StrategyReport {
    const trades = this.closedList.length;
    const wins = this.wintrades;
    const list = this.closedList
      .slice(-500)
      .reverse()
      .map((t) => ({
        side: t.side === 1 ? ("long" as const) : ("short" as const),
        entryId: t.entryId,
        exitId: t.exitId,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        qty: t.qty,
        profit: t.profit,
        profitPct: (t.profit / (t.entryPrice * t.qty)) * 100,
      }));
    return {
      initialCapital: this.s.initialCapital,
      netProfit: this.net,
      netProfitPct: (this.net / this.s.initialCapital) * 100,
      grossProfit: this.grossP,
      grossLoss: this.grossL,
      profitFactor: this.grossL > 0 ? this.grossP / this.grossL : null,
      trades,
      wins,
      losses: this.losstrades,
      winRate: trades ? wins / trades : null,
      avgTrade: trades ? this.net / trades : null,
      maxDrawdown: this.maxDD,
      maxDrawdownPct: this.maxDDPct,
      openTrades: this.openList.length,
      openProfit: this.openprofit,
      commission: this.paid,
      list,
    };
  }
}
