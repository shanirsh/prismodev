# Validation week log (June 12-16, 2026)

Paper cuts, observations, and metric notes from the measurement window. Fix bugs; log everything else here instead of changing the product.

- 2026-06-12: connector auto-detect was creating a .prismo backup every 5 min when content was unchanged (735 .bak files/day) — fixed in v0.1.46.
