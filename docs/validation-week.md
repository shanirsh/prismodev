# Validation week log (June 12-16, 2026)

Paper cuts, observations, and metric notes from the measurement window. Fix bugs; log everything else here instead of changing the product.

- 2026-06-12: connector auto-detect was creating a .prismo backup every 5 min when content was unchanged (735 .bak files/day) — fixed in v0.1.46.
- 2026-06-12: SaaS frontend test harness still emits two warnings during dogfooding: Supabase auth-js probes Node localStorage without a localstorage file, and useWorkspaceData has an existing exhaustive-deps warning. Left as paper cuts during freeze; Recharts mock hoisting warning was fixed in the SaaS repo.
- 2026-06-12: follow-up dogfood found optimize-report.md still churned backups because the report timestamp changed every auto-detect. Fixed by comparing optimize reports with the generated-at line normalized and added a repeated-run regression test.
- 2026-06-12: follow-up dogfood found backend-summary.md could churn backups because generated .prismo context files influenced load-bearing text-reference counts. Excluded .prismo generated context from the reference corpus and added a regression test; repeated optimize on the SaaS repo now produces 0 new .bak files after the one-time old-report replacement.
- 2026-06-12: connector dogfood found scoped `optimize frontend` and unscoped `optimize` could alternate optimize-report.md's Generated Files list and create metadata-only backups. Changed optimize-report metadata-only changes to update without backups and added a scoped/unscoped regression test.
- 2026-06-12: connector dogfood found legitimate generated-context changes still left timestamped `.prismo/*.bak` files, which made the repo look dirty during validation. Changed `prismo optimize` context files to update in place because they are reproducible generated artifacts; user-authored files still keep backups.
- 2026-06-14: THREE real bugs found via dogfooding, all fixed + shipped (v0.1.47-0.1.51):
  1. Digest counted auto-detect health scans as interventions (186 fake vs 3 real).
  2. Verification baseline poisoned by Cursor's blind 0-signals -> now compares like-for-like across tools.
  3. CRITICAL: Claude Code telemetry silently dropped when repo path has a space/dot ("Code Projects") -> path encoding now matches Claude's. Was hiding the strongest signal for any user with a spaced path.
- 2026-06-14: KNOWN BUG (not yet fixed): `prismo protect` reinstalls/repoints the single connector even when one is already running for another repo, silently hijacking which repo syncs. Connector is single-repo; working across multiple repos means only the watched one syncs to the dashboard. Post-freeze: make protect not move a running connector, and consider syncing all recent repos.
