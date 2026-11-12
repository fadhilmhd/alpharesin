# Security

## Reporting a problem

Email **support@alphapinelab.com** with "AlphaResin security" in the subject.
Please don't open a public issue for a security problem.

Say what you found, the version (`alpharesin --version`), and the smallest
script or file that shows it. We aim to reply within a week, agree a fix and
a date with you, and credit you in the changelog if you'd like that.

## Supported versions

AlphaResin is at an early version (0.x). Fixes go into the newest version
only; update to it before reporting.

## What counts

AlphaResin turns Pine source into JavaScript that something then runs, so the
boundary between the two matters most. In scope:

- **The converter writes code the script didn't ask for.** For example, a
  string, name or comment in a Pine script that ends up as JavaScript that
  runs, beyond what the script's own logic does.
- **The command reads or writes files it wasn't given**, or runs anything
  other than the converted module.
- **The playground** (https://fadhilmhd.github.io/alpharesin/) sends a script
  or bars off the page, or a converted module escapes the playground's worker.
- **The package or the repository's workflows** could ship something other
  than this repository's code (the release, its provenance, the build).

Not in scope, but welcome as ordinary issues:

- **Running a converted module is running code.** JavaScript isn't sandboxed by
  itself: a host must isolate what it runs, for example in a worker with no
  network and a time limit (the playground stops its worker after 10 seconds).
  A script that loops for a long time or uses a lot of memory in a host that
  doesn't isolate it is that host's to contain.
- Values that differ from another platform's, scripts that don't convert, and
  other bugs.
