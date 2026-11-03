# Consistency-check fixtures (semantius-architect)

Offline check that `../../references/consistency-check.ts` reports exactly the expected issues on a set of small blueprints and specs. It focuses on the access-level contract: process gates, the admin roll-up, and the high-risk marker.

```bash
bun evals/consistency-check/check.ts   # from the semantius-architect skill folder; exit 0 = green
```

Each `fixture-<name>.md` is run through the checker's CLI on its own, and its printed issues are compared with `expected-<name>.json`. That file is a list of `{ "check", "detail", "warn"? }` entries:
- `check` is the check name the checker prints.
- `detail` is a substring of the printed detail.
- `warn: true` marks a `⚠` warning.

Every expected entry must match exactly one printed issue, and no printed issue may be left over. The exit code must be 1 when an error is expected and 0 otherwise. `[]` means the fixture is consistent.

Blueprints (module `purchase-requests`: an approval gate, an order gate, and a vendor `create` gate with no §7 row):
- `blueprint-gated`: `gated` with a high-risk approval gate. The admin holds every gate, the high-risk one too (✓ in §8.1, a §9.1 `<slug>:admin` → gate row). Consistent.
- `blueprint-raci`: `raci` with the seven-column §7 (no `high risk?` column), so no gate is high-risk. The admin holds every gate, and the RACI realization gives each gate to one accountable row. Consistent.
- `blueprint-raci-high-risk`: `raci` with the eight-column §7 and a high-risk approval gate (`-` in §8.1, no admin → gate row), derived by two §7 rows that agree on `high risk?`. The order gate and the `create` gate stay held by the admin. Consistent.
- `blueprint-basic`: `basic`. Every §7 derived gate is `<slug>:admin`, with no lifecycle rows and no admin → gate rows. The `high risk?` ✓ has no effect at this level. Consistent.
- `blueprint-raci-high-risk-admin`: `raci` where the admin holds the high-risk gate (✓ and a hierarchy row) and misses the ordinary order gate (`-`, no hierarchy row). 4 errors.
- `blueprint-gated-missing-admin`: `gated` with three faults: the high-risk gate is left out of the admin roll-up, the `create` gate has no admin → gate row, and a §7 row keeps the `<slug>:admin` derived gate. 4 errors.
- `blueprint-advanced-lifecycle`: `advanced` with a lifecycle row and an own-code derived gate, both of which are allowed only under `gated` and `raci`. 2 errors.
- `blueprint-high-risk-cells`: `gated` with a `high risk?` cell that reads `yes`, and a ✓ on a state with no gate. 2 errors.
- `blueprint-raci-high-risk-conflict`: `raci` where the two §7 rows deriving the approval gate disagree on `high risk?`. 1 error; the gate's admin checks are skipped, so nothing else is reported.
- `blueprint-role-header`: `blueprint-basic` with its §3 column named `role`. File format 3.1 accepts either name, so it stays consistent.

Specs (module `expense-claims`: a claim with approval and payment gates, and a `parent` + `cascade` line with its own dispute gate; every rule cites its gate through `has_permission`):
- `spec-gated`: `gated` with the six-column §8.1 and a high-risk approval gate held by the admin. FK scope counts each lifecycle gate as `<slug>:admin` here, so the line and the claim share one scope. Consistent.
- `spec-raci`: `raci` (documentation mode) with the six-column §8.1. The high-risk approval gate is `-` with no hierarchy row; the other two gates are ✓ with their admin → gate rows. FK scope warns that the line checks its own gate. Consistent, 1 warning.
- `spec-raci-bad`: `raci` with four faults: the high-risk gate is rolled up under admin (✓ and a hierarchy row), a baseline row is marked high-risk, and a lifecycle row reads `yes`. 4 errors, 1 warning.
- `spec-raci-five-column`: `raci` with a five-column §8.1 (no `high risk?` column, so no gate is high-risk) where no gate is held by the admin (`-`, no admin → gate rows). 6 errors (✓ and the row, for each of 3 gates), 1 warning.
- `spec-gated-five-column`: `gated` with a five-column §8.1. One lifecycle gate is left out of the admin roll-up (`-`, no row), and another shows ✓ but has no admin → gate row. 3 errors.

No Semantius instance is needed. Keep the fixtures minimal, and add one only when a checker branch needs covering.
