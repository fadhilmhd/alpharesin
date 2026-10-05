# How AlphaResin is written: clean room

AlphaResin re-implements a language whose owner publishes its documentation but
not its implementation. This page records what AlphaResin is written from, and
what it is never written from, so anyone can see where every part comes from.

## Written from

- **TradingView's public documentation:** the Pine Script® v6 Reference
  Manual and User Manual, read as published on tradingview.com.
  - AlphaResin keeps the language's facts from them: names, parameters, types,
    and behaviour as described.
  - It keeps none of their text. Every comment and document in AlphaResin is
    written in its own words.
- **What TradingView's charts show:**
  - the values a script plots, observed on the chart or in an
    "Export chart data" file of one's own chart;
  - those exports are compared with AlphaResin's runs. They stay with whoever
    made them and are never committed.
- **AlphaResin's own tests and reasoning.**

## Never written from

- **TradingView's code:**
  - its client or server software;
  - its scripts' compiled form;
  - any of its files beyond the documentation as it reads on the page.
- **Other implementations of Pine, whatever their licence:**
  - PineTS (AGPL-3.0);
  - any implementation whose licence doesn't allow it.

  Contributors who have read such code don't write the part it covers.
- **Collected scripts beyond testing:**
  - public scripts may be run through AlphaResin to find what doesn't convert yet;
  - their code isn't copied into AlphaResin, its tests or its documentation.

## The reference names

`packages/resin/src/reference/params.ts` lists each built-in's parameter names and the
namespaced variables and constants. Converted code needs them to place named
arguments and to know a built-in from a script's own names.
- **Source:** they were noted from the public Reference Manual as it reads on
  the page, by `packages/resin/scripts/note-reference.mjs`, which records how.
- **What is kept:** names only; no text.

## If something doesn't belong

If you find anything in AlphaResin that came from a source above it shouldn't
have, open an issue. It will be removed and rewritten from the right sources.
