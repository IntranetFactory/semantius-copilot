*Reference for `semantius-architect`. Read before this stage's first output in a run (mandatory load, SKILL.md stage index).*

### Stage 8: Business-rule emission

Computed fields, validation rules, and the 15-family scan walk moved to the analyst skill. The blueprint stops at entity level: §8 declares permissions and business rules at the intent level only (`rule_name + data_object + source_flag + intent`). The analyst converts each blueprint §8.2 rule into JsonLogic and runs the full scan walk in its Stage 10.

**Approvals are not a §8.2 source flag.** An approval is a gated lifecycle transition: a §7 `requires_permission? = ✓` row into the approved state; under the `gated` and `raci` access levels it also gets the matching `<system_slug>:approve_<noun>` `workflow-gate (lifecycle)` row in §8.1, and under `raci` the §9 RACI Accountable actor (see the body table in stage-10-workflow-perms.md). Genuine multi-party approval (a count of distinct approvers) is a field-level rule the analyst authors; the blueprint just declares the gated transition.

### Stage 9 — Classify each entity's `entity_type`, then derive its write tier

The class and the write tier are `use-semantius` concepts: the six classes, the derivation ladder, the class-to-write-tier table and the rules for junctions are in `use-semantius` `references/data-modeling.md` → "Classifying an entity", and the tier-to-permission mapping is in `references/rbac.md` → "Choosing an entity's permissions". Read both before this stage. This stage applies them to the blueprint: walk every entity once, assign its **`entity_type`** (feeds the §3 `entity_type` column), then derive the **`write tier`** from the class (never the other way round; feeds the §3 `write tier` column and the permissions §8.1 declares). Never invent an `entity_type` outside the closed set.

**Two paths to the class.**

- **Carry-forward (catalog-clones).** When the entity descends from an upstream `data_objects` row whose `entity_type` is **classified** (not `unclassified` / null), that value is authoritative: carry it through verbatim, do not re-derive. Treat an upstream `unclassified` / null as **absent** and derive locally; never propagate `unclassified` as a decision.
- **Derive (all greenfield, plus any `unclassified` upstream tail).** Greenfield has no ancestor, so it always derives, with the `use-semantius` ladder. Where the ladder reads the entity's relationships and lifecycle, read blueprint **§5** (relationships, including the junction test and the family bases named by a §3 `**Key types:**` row) and **§7** (a lifecycle with at least one ✓ `requires_permission?` row is a gated step; a lifecycle with no ✓ row is not). Stage 9 runs before the gates are confirmed, so use the gates the Stage 10 scan rules would fire on the Stage 5 lifecycles; if the Stage 10 confirmation drops an entity's last gate, the entity becomes `operational_record`, said in one line of that confirmation. A submit-then-lock posture is orthogonal and never makes an entity `catalog`.

**Platform built-ins** (`users`, `roles`, `permissions`, declared in §3 only for self-containment) are classified by data kind: `users` → `operational_record`; `roles` / `permissions` → `catalog`. They are deduplicated at deploy, so this is informational, but emit it.

**The `write tier` column** takes the tier `use-semantius` gives the class. One blueprint-only case: an `embedded_master` whose catalog owner is absent and may shift the tier is `:manage` _(pending)_; the pending qualifier is orthogonal to the class.

Common `catalog` shapes by domain (illustrative, not exhaustive):

- ATS: `candidate_sources`, `application_stages`, `departments`
- CRM: `lead_sources`, `pipeline_stages`, `industries`, `currencies`
- ITSM: `priorities`, `categories`, `ticket_types`, `sla_definitions`
- HRIS: `job_titles`, `pay_grades`, `leave_types`, `cost_centers`, `departments`
- Product Roadmap: `feature_types`, `tags`, `release_trains`

Common `operational_*` shapes (the records that capture *work happening*): `candidates`, `job_applications`, `interviews`, `offers`, `tickets`, `incidents`, `leads`, `opportunities`, `features`, `votes`, `comments`, `notes`. Those with a gated §7 lifecycle (a candidate's hire flow, an offer's approval, a ticket's close) are `operational_workflow`; the rest are `operational_record`.

**Edge-case entities deserve a moment's thought.** Junction tables (`hiring_team_members`, `feature_votes`, `campaign_members`) are `junction` and write `:manage` unless **all** parent legs are `catalog`. Entities like `releases` or `sprints` that are *named time-windows* are `operational_record` (added every cycle); entities like `release_trains` or `pipelines` (the *configurations*) are `catalog`.

**Surface the classification to the user before §3 is finalized.** Required in guided and expert flow; it is its own turn, never combined with another stage's confirmation. Present a short table in plain words (Convention 8). The internal class and tier stay your working values; the user sees what they mean:

- **Kind:** `catalog` = setup list, `operational_record` = everyday record, `operational_workflow` = record with steps, `junction` = connecting record, `computed` = calculated.
- **Kind of editing:** "settings maintenance" for setup lists (the `:admin` tier), "everyday records" for everything else. Never name admins or any role here: the access level is decided later (Stage 10), so who edits is not known yet.
- **Could be shared with other tools:** the master-cluster hint below in plain words, or blank. It is only a possibility: sharing happens only if that module exists and the user approves it when deploying.

> **What you track and how it's edited.**
>
> | What's tracked | Kind | Kind of editing | Why | Could be shared with other tools |
> |---|---|---|---|---|
> | Candidate sources | setup list | settings maintenance | a short list the applications pick from, filled in once | |
> | Application stages | setup list | settings maintenance | the steps of the hiring pipeline, defined once | |
> | Job applications | record with steps | everyday records | each one moves from screening to offer to hired, with a restricted step | |
> | Interview notes | everyday record | everyday records | added all the time, no steps | |
> | Hiring team members | connecting record | everyday records | relates people to the jobs they hire for | |
>
> Does this look right?

> **Fast flow, after the go-ahead:** don't show the table and don't ask; accept the classification (and any master-cluster hints) as drafted and log one line ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 4).

Loop on user feedback until they confirm. The classification feeds the §3 `entity_type` column and the derived `write tier` column (both written in Stage 13) and the §8.1 permission enumeration.

**Master-concept cluster hints.** During the same Stage 9 walk, also identify entities that are classic **master concepts** — entities that other domain modules across the catalog are likely to reference as shared data rather than redeclaring locally. Emit a `**Shared master cluster:** <cluster>` annotation in §3 for each one. The hint travels inside the self-contained model and shapes the deployer's default suggestions at the master-promotion prompt, without binding the tenant to any specific taxonomy.

The hint is **optional and per-entity**; omit it when the entity is not a master concept. Default cluster names the analyst should use when one fits:

| Entity examples | Suggested cluster |
|---|---|
| `currencies`, `cost_centers`, `budget_periods`, `ledger_accounts`, `fiscal_years`, `tax_rates`, `gl_accounts` | `finance` |
| `business_partners`, `vendors`, `customers`, `partners`, `suppliers` (when a company can be several of these, one `business_partners` base with `has_a` entities: see `normalization.md`) | `parties` |
| `departments`, `business_units`, `locations`, `sites` | `organization` |
| `products`, `product_categories`, `skus` | `products` |
| `employees`, `job_titles` | `employees` |

The mapping is not closed; coin a new cluster name when the entity is a recognizable master concept that doesn't fit one of the above (e.g. `pricing` for `price_lists`, `pricing_tiers`; `geo` for `countries`, `regions`, `time_zones`). Use snake_case. Prefer a domain noun the user would recognize at the prompt over an entity-name suffix.

The hint never overrides the user — the deployer surfaces it as a recommendation at Stage 2d follow-up 1, and the user can always pick a different host module or write a custom name at the prompt. **Authors review the cluster classification at confirmation time, same as the `entity_type` classification.** It fills the "Could be shared with other tools" column of the same Stage 9 table, in plain words:

> | What's tracked | Kind | Kind of editing | Why | Could be shared with other tools |
> |---|---|---|---|---|
> | Payment terms | setup list | settings maintenance | a short list, filled in once | finance |
> | Vendors | everyday record | everyday records | companies the business buys from, added all the time | business partners |
> | Cost centers | setup list | settings maintenance | reference data, filled in once | finance |

**Narrow-tier override.** The narrow tier is a Stage 10 (W4n) decision layered on top of the Stage 9 class, not an `entity_type` value. An entity whose primary writers are external participants (e.g. `interview_feedback` writers get `ats:interview` rather than `ats:manage`) keeps its derived §3 `write tier` (`:manage`, from `operational_workflow` / `operational_record`); Stage 10 then declares the narrow tier as a `narrow`-tier row in §8.1 plus a `narrow_write` rule in §8.2 (narrow is never a §3 `write tier` value and never an `entity_type` value). `catalog` entities are never narrow-tier-overridden (the two sit at opposite ends of the authority axis).

How many permissions the module gets is decided by the access level (stage-10-workflow-perms.md, permission step), not here.
