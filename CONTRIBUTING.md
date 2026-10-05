# Contributing to AlphaResin

Thank you for helping. A new target language, a built-in that's missing, a
fix, a test script or an idea: each one makes AlphaResin useful to more people.
This page says how to contribute, and how your contribution stays yours.

## Your credit is kept

AlphaResin is built by many hands. Nobody's work is renamed, absorbed or
forgotten.

1. **Your name stays on your commits.** Pull requests are merged in a way
   that keeps each commit's author. When several commits are squashed into
   one, every author is credited on it with a `Co-authored-by:` line.
   Authorship is never rewritten.
2. **You sign off what you contribute.** Add `Signed-off-by: Your Name <you@example.com>`
   to each commit; `git commit -s` does it for you. It certifies the
   [Developer Certificate of Origin](https://developercertificate.org/): the
   work is yours to give, or you have the right to pass it on. That record is
   how the project can always show where every line came from.
3. **You're listed in [CONTRIBUTORS.md](CONTRIBUTORS.md).** Add yourself in
   your first pull request. Entries are never removed, even if code you wrote
   is later rewritten.
4. **Ideas count too.** When a feature starts from someone's issue or
   discussion, the pull request links to it, and that person is listed under
   *Ideas* in CONTRIBUTORS.md.
5. **Larger work is named in NOTICE.** Whoever builds a new target or a
   substantial part of one may add an attribution line to `NOTICE`.
   - Under the Apache License (section 4(d)), anyone who redistributes AlphaResin
     must keep those lines.
   - So that credit travels with every copy and fork, not just this repository.
6. **You keep your copyright.** Contributions come in under the project's
   licence, Apache-2.0 (section 5). You keep the copyright to your work, and
   the licence keeps it open for everyone.

## Ground rules

- **Clean room.**
  - Write only from TradingView's public language reference and user manual,
    and from what you observe on TradingView's charts.
  - Never read, copy or adapt code from PineTS or any other AGPL-licensed or
    unlicensed Pine implementation. If you have read such code, say so, and
    let someone else write that part.
- **No one else's data.**
  - TradingView exports stay with whoever made them; don't commit them.
  - Scripts you didn't write are shared only under their author's licence,
    and only as much as the bug needs.
- **The host decides what fits.**
  - When a Pine feature has no place in the host a target writes for, leave
    it out with a warning that says why.
  - Reserve errors for what isn't valid Pine.
- **Plain TypeScript.**
  - `packages/resin/src/` runs in browsers and in Node: no platform APIs, no runtime
    dependencies.
  - Comments explain why, in plain words.
- **Tests with every change.** `npm test` and `npm run typecheck` pass before
  a pull request.

## Adding a target

A target turns AlphaResin's syntax tree into another language, together with
whatever runtime that language needs.

1. **Open an issue first.** Name:
   - the language;
   - what the converted scripts will run on;
   - who will maintain it.

   Agreeing on the shape early saves rework.
2. **Start from the syntax tree** (`packages/resin/src/ast.ts`), after linking (`packages/resin/src/link.ts`).
   Today the one target, the AlphaPine SDK, lives in `packages/resin/src/convert.ts`:
   - it is the model for how state, history and series work;
   - when the second target arrives, the two move under `packages/resin/src/targets/`, sharing
     whatever they turn out to have in common;
   - the first new target's authors help decide that shape.
3. **Follow the semantics, not the syntax.**
   - Pine runs a script once per bar.
   - Each `ta.*` call keeps its own state.
   - `x[k]` reads history.
   - `na` spreads through arithmetic.
   - `request.security` follows its timeframe rules.

   `@alphapine/engine`'s `pine.ts` shows one way to keep all of that, with
   comments on each rule.
4. **Prove it.** The conformance scripts (`packages/resin/conformance/`) plot the built-ins.
   A target is ready when its runs agree with TradingView's exports of those
   scripts, column by column, like the SDK target's.
5. **Document it.**
   - A README in the target's folder says what converts and what is left out.
   - It names the target's authors and maintainers.

## Adding a built-in

1. **Find it** in TradingView's public reference. Note its parameters and
   what it returns.
2. **Implement it** in the runtime (`@alphapine/engine`, `pine.ts` or
   `broker.ts`), and map it in the target (`packages/resin/src/convert.ts`).
3. **Test it.**
   - Test against a definition written out in the test itself.
   - If you can, also test against a TradingView export of a script that
     plots it.

## Reporting a script that doesn't convert

Open an issue with:
- the smallest piece of Pine that shows the problem;
- what AlphaResin said;
- what TradingView does.

If the script isn't yours, share only that small piece.

## Conduct

Be kind and assume good faith. Critique code, not people. Maintainers may
remove anything that makes this a worse place to contribute.
