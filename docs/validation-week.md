# Validation week log (June 12-16, 2026)

Paper cuts, observations, and metric notes from the measurement window. Fix bugs; log everything else here instead of changing the product.

- 2026-06-12: connector auto-detect was creating a .prismo backup every 5 min when content was unchanged (735 .bak files/day) — fixed in v0.1.46.
- 2026-06-12: SaaS frontend test harness still emits two warnings during dogfooding: Supabase auth-js probes Node localStorage without a localstorage file, and useWorkspaceData has an existing exhaustive-deps warning. Left as paper cuts during freeze; Recharts mock hoisting warning was fixed in the SaaS repo.
