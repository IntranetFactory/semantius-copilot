# Stage 3: Plan and present (modeler reference)

_Read this when the workflow reaches Stage 3. The stage map is in SKILL.md._

## Stage 3: Plan and Present (and resolve ambiguity)

Before running any writes, show the user a clear plan. The plan must have two parts: (1) the normal module/permission/entity summary, and (2) **an ambiguity-decisions section if any 🛑 buckets were raised in Stage 2**. No writes happen until every 🛑 has an explicit decision.

### Normal plan (example)

```
📦 Module: saas_expense_tracker
  ✨ Will create (new module)
  🔑 Permissions: ✨ saas_expense_tracker:read, ✨ saas_expense_tracker:manage, ✨ saas_expense_tracker:admin
  🔑 Per-table permissions: ✨ 12 (view and edit for 6 tables)
  🔗 Permission hierarchy: ✨ admin → manage, ✨ manage → read, ✨ 18 for the per-table permissions
  🛠 Admin-tier entities (edit permission included by saas_expense_tracker:admin): departments, budget_periods
  🛠 Operational entities (edit permission included by saas_expense_tracker:manage): every other entity below

🗂 Entities (7 total):
  🔒 users (Semantius built-in, reusing; model declares 3 extra fields: `department_id`, `job_title`, `employee_id`, will add additively with user confirmation)
  ✨ vendors: will create + 6 fields
  ✨ subscriptions: will create + 26 fields
  ✨ departments: will create + 5 fields
  ✨ budget_periods: will create + 6 fields
  ✨ budget_lines: will create + 8 fields
  ✨ license_assignments: will create + 7 fields

Total to create: 1 module, 15 permissions, 20 hierarchy rows, 6 entities, ~58 fields
Plus: 3 additive fields on built-in `users` (pending confirmation)

🧠 Entity-level rules (calculated values and save-time checks):
  ✨ `subscriptions`: 1 computed_fields, 3 validation_rules
  ✨ `budget_lines`: 2 validation_rules

👁 Entity-level read rules (who can see which records):
  ⚠️ `license_assignments`: ✨ select_rule, will scope per-row visibility to the row's `assignee_user_id` (medium-risk visibility change, pending confirmation)

🎛 Field-level UI rules (how fields behave on the form):
  ✨ `subscriptions.renewal_date`: input_type_rule (hidden until workflow_state=`renewed`)
  ✨ `subscriptions.canceled_at`: input_type_rule (hidden until workflow_state=`canceled`, then readonly)
  ✨ `budget_lines.approved_at`: input_type_rule (readonly once workflow_state=`approved`)

🔗 Relationships to other modules:
  ✨ Propose on `subscriptions`: + `contract_id → contracts` (governs, required: yes, restrict); pending confirmation
  ✨ Propose on `subscriptions`: + `project_id → projects` (charged to, required: no, clear); pending confirmation
  💤 Skipped (other table not installed): `subscriptions → cost_allocation_rules`
```

The read-side and UI-rule sub-sections only appear when the model declares them (most models omit them; the sub-sections are omitted from the plan too — don't render empty bullets). The `select_rule` row carries the `⚠️` marker because applying it changes who can see which rows (medium-risk visibility shift); the deployer pauses for explicit confirmation on every `select_rule` create / modify / remove (in guided and expert flow), same posture as a tier flip.

If the module already exists, swap `✨ Will create` for `♻️ Exists (ID: 12), will update module metadata from the new model and diff entities to apply only changes`. Render the field-level deltas inline under each ♻️ entity so the user sees exactly what's about to change, not just a vague "will diff" promise:

```
🗂 Entities (7 total):
  ♻️ subscriptions: 26 fields, 4 drifted, 1 new
     ~ vendor_name.description: "Vendor" → "Legal name of the contracting vendor"
     ~ workflow_state.enum_values: + "renewed", + "expired"
     ~ priority.enum_values: colors and icons on every entry (cosmetic)
     ~ amount.searchable: false → true
     ~ contract_url.format: text → html (same primitive, accepted)
     + renewal_date (date, optional)
     ⚠️ select_rule: new (model adds row-level visibility scope on `created_by_user_id`)
     + renewal_date.input_type_rule: hidden-until-renewed
  ♻️ vendors: 6 fields, no drift
  ✨ budget_lines: will create + 8 fields
```

Use `~` for drifted properties (with `old → new`), `+` for additions, and surface `🛑` separately for anything that blocks the fast-path (enum removals, cross-primitive format changes, field deletions, tier flips). The 🛑 deltas route through the normal Stage 3 ambiguity dialog; the `~` and `+` deltas are informational and apply automatically once the plan is approved (or under the clean re-run fast-path, immediately). The `⚠️ select_rule` line is **not** auto-applied even under the fast-path — read-visibility changes always pause for explicit user confirmation (guided and expert flow; same rule as `edit_permission` tier flips).

> **Fast flow, after the go-ahead:** a 🛑 delta that removes or retypes live data (an enum value removal, a cross-primitive format change, a field deletion) is skipped: never remove anything, keep what is deployed, and continue; a permission-tier flip and the `select_rule` pause proceed as the spec says, except that a flip narrowing who can edit keeps the old bundle's row; log each one that proceeds with `log_pick modeler` ([fast-flow.md](../../semantius-admin/references/fast-flow.md), section 5); don't ask.

### Plan-summary lines for master-data flows

The Stage 3 plan emits these standardized line types when master-data operations are in play. They appear alongside the normal `📦 ✨ ♻️ 🔑 🔗 🛠 🗂 🔒 🧠 👁 🎛 💤` vocabulary; each is a discrete decision the user sees before approval.

| Line | Meaning |
|---|---|
| `🟢 <entity> → already shared in <master_module>` | Branch A wire-up. Entity exists in a master module; this consumer is being added. Includes the read inclusion to that entity's view permission (always) and notes whether a write inclusion to its edit permission is also planned (when §9.1 carries it). |
| `🔗 Permission inclusions (cross-module, new)` block | Counts the `permission_hierarchy` rows this deploy will create across module boundaries: one line per module and target, never one line per table, with `[origin=model_master]` on the rows Stage 4i adds and the manage-option label on a shared-module move. |
| `🆕 Master module created: <slug>` | A new `module_type = "master"` module will be created (either by promotion at Stage 2d Branch B, or by an upfront master-model deploy). |
| `🔁 Renaming master module:` block | A master-model deploy is renaming an existing master in place (cascade per Stage 4b-rename: module slug + per-tier permission codes + per-tier role slugs). Old → new on each line. |
| `📥 Merging master modules:` block | A master-model deploy is consolidating multiple single-entity masters into one domain cluster (Path 2, plan §5.4.5). Lists each source master being merged in and the target. Source masters are left as quiet orphans (never deleted per "No auto-deletion"). |
| `✨ <slug>:admin / <slug>_admin role` | Three-permission upgrade case: the model now needs `:admin` where the live module only had `:read` / `:manage`. Adds the missing permission, role, hierarchy row, and module FK columns. |
| `🌱 Seeded <master>_manager with N members from <original>_manager` | A shared-module move (Stage 2d) seeds the master's manager role from the original module's manager-role members. Snapshot-time copy; new `<original>_manager` members added later don't auto-inherit master stewardship. An adoption never seeds. |
| `💡 Cluster hint: <entity> → <cluster>` | An entity in this deploy carries an analyst-emitted `**Shared master cluster:**` annotation, and the hint is shaping a Stage 2d follow-up 1 default (existing-master match or new-module name suggestion). Informational; the user can override at the prompt. |
| `🏷 module_kind = <kind>` | Informational label from frontmatter (`domain` / `master` / `starter` / etc.). No behavior switch. |
| `🔐 Access level: <plain words>` | The spec's `access_scope`, named in plain words: `basic` "view and edit"; `advanced` "view, edit and admin"; `gated` "the admin takes the restricted steps"; `raci` "business roles take the restricted steps, and admins can step in except on high-risk steps"; `custom` "permissions set up by hand, left as they are". |
| `👥 Personas to provision: <list>` | Per-persona summary from §9 RACI + frontmatter `persona`. Stage 4k creates each named persona as a tenant role and grants its RACI permissions. Each line names the persona slug and the count of grants. **Shown only under `access_scope: raci`.** |
| `🏢 Functional ownership: owner = <function>.<role>, contributor = <function>.<role>` | Summary from §9.2 functional ownership table. Stage 4l grants the named default-tier permission to the named default role for each row. |
| `🔑 Per-table permissions: ✨ <N> (view and edit for <M> tables)` | The `entity-read` and `entity-write` rows of §8.1, always as a count, never one line each. A table this module only reads counts one permission. Shown at every access level except `custom`. |
| `🏠 Permissions kept here until their home module is installed: <N>` | §8.1 rows this module will hold whose prefix names a module that is not installed yet (Stage 2a holder rule). A count. Nothing changes for them when that module arrives except who holds them. |
| `🏠 Permissions moving to their home module: <N> from <module>` | §8.1 rows the holder rule moves here from another module. A count. Names, grants and hierarchy rows do not change. |
| `✂️ <Module> managers stop editing <Plural Label>; only the new manager group can. Deploying <Module> again restores their access` | A shared-module move with "a new dedicated manager group" (`manage_option: 1`): Stage 4i deletes the old module's hierarchy row to this entity's edit permission. That module's §9.1 still lists the row, so a later deploy of its spec adds it back. |
| `✂️ <Module> managers stop editing <Plural Label>` | A confirmed tier flip that narrows who can edit: Stage 4b deletes this module's old bundle row to this entity's edit permission. |
| `⚠️ Skipping <entity>.<state> — ⚠ <annotation kind>` | Per §7 lifecycle row carrying a `⚠ state-machine shape` or `⚠ unresolved gate` annotation. The deployer SKIPS the row (does NOT silently provision). The line is informational + halt-on-execute. |
| `💤 Skipping relationship <from>.<target_id> → <target_entity>: other table not installed` | A relationship to an entity that is neither live nor created in this deploy creates no field: Stage 2g marks a §6 row dormant, and Stage 4d leaves out a reference / parent FK. |

Example master-data plan block (Branch B promotion + Branch A wire-up + cluster hint):

```
🗂 Master-data operations:
  🛑 vendors — cross-module collision with `itsm.vendors` (domain module)
     💡 Cluster hint: vendors → parties
     ⚠️ Will request: 4-option resolution (promote / rename incoming / use existing / abort) + follow-ups (host module, manage decision)
  🟢 cost_centers → already shared in `finance` master (auto-wire)
  💡 Cluster hint: cost_centers → finance (matched existing master `finance`, recommended)
  🌱 (planned) Seed `parties_manager` with 3 members from `itsm_manager` if option 1 picked
🔗 Permission inclusions (cross-module, new):
   parties: view 1 table, edit 1 table                                        [origin=model_master]
   itsm: view 1 table in parties, edit pending manage-option pick             [origin=model_master]
   itam: view 1 table in parties, edit pending manage-option pick             [origin=model_master]
   itam: view 1 table in finance                                              [origin=model_master, Branch A read inclusion]
```

### Cross-model relationship suggestions (additive, reversible)

§6 relationship proposals are **additive and reversible**: adding a cross-module FK never deletes data and can be removed later by editing the model and redeploying. A `Required = no` relationship never breaks the local module. A `Required = yes` relationship is enforced by the platform, so writes to `from_table` must then supply it; the Stage 1 default-value guard protects a table that already holds rows. Because proposals default to `Required = no`, the deployer's posture is *err toward implementing*. Don't drag the user through individual confirmation when the analyst has already drafted a hint and the target exists in the catalog.

**Print the relationship-proposal summary as prose first** (the same `🔗 Relationships to other modules` block from the normal plan), so the user has the list in front of them before any widget appears. Each proposal line carries the row's verb, `Required` and `Delete` values. The modeler never asks about `Required`: it deploys the value the spec carries.

**These questions run through the question ledger** (SKILL.md → Task tracking; sequence in `../../semantius-admin/references/task-tracking.md`): enumerate every ambiguous row, every field-name collision, and (when it applies) the four-or-more-proposals question into `Q:` tasks first, then ask them in batches of up to four per `AskUserQuestion` call, apply each answer to the in-memory plan, complete the task, and repeat until `TaskList` shows no open `Q:` task. Only then render the plan and fire Gate A.

**Resolve Ambiguous rows first.** Any rows marked 🟡 Ambiguous in Stage 2g (multiple plausible targets matched the `References` concept) gate which proposals are even askable. One `Q:` task per ambiguous row (`Q: Which table should <FK Table Label> relate to for "<References>"?`), batched up to four per call. Each question is `multiSelect: false` with **at most 3 candidate target tables** as options (label `"<Plural Label> in <Module Display Name>"`; when more than 3 matched, list the 3 whose owning module is closest to the model's expected context and end the question text with `" Type the name of another table if it isn't listed."`; the tool adds its own free-text slot, never list an "Other" option) plus a `"Skip this relationship"` option, so every question holds 2 to 4 options. After the user picks, the Ambiguous rows that resolved promote into the ✨ Proposed list and the rest drop out.

> **Fast flow, after the go-ahead:** no `Q:` task and no question: pick the candidate whose table name exactly matches the row's `References`, else "Skip this relationship"; log it with `log_pick modeler`; don't ask.

**Resolve Field-name collisions next.** Any row marked 🛑 Field-name collision in Stage 2g (the auto-generated `<target_singular>_id` already exists on `from_table`) is one `Q:` task each (`Q: <From Label> already has a field named <fk>. Use another name for the relationship, or skip it?`), batched with the ambiguous rows. `multiSelect: false`, exactly 2 options: `"Name the relationship related_<target_singular>_id instead (Recommended)"` (the deployer derives the name, checks it is free on `from_table` against the field list Stage 2g already read, and appends `_2` if it is taken) and `"Skip this relationship"`; any other field name is written into the tool's free-text slot (never list an "Other" option; a 1-option question is rejected by the tool) and gets the same free-name check, re-asked once if taken. Unresolved-source rows are also surfaced here for the user to fix the model via the analyst skill before this stage retries.

> **Fast flow, after the go-ahead:** no `Q:` task and no question: take the Recommended option (name the relationship `related_<target_singular>_id`, with the same free-name check); log it with `log_pick modeler`; don't ask. An unresolved-source row is still a stop.

**Then approve the Proposed list.**

- **0 proposals**, skip this section entirely; nothing to ask.
- **1–3 proposals**, present inline with one combined confirmation (a standalone question, not a ledger task): *"Apply these N cross-model relationship suggestions? [yes / review each / skip all]"*. Default branch on `yes` is "apply all".
- **4 or more proposals**, one `Q:` task (`Q: Add all <N> relationships to other modules, or review each one?`), asked as:

  - **question**: `"Found N possible relationships between this module and other modules already deployed. How should we handle them?"`
  - **header**: `"Module relationships"`
  - **multiSelect**: `false`
  - **options** (in this order, recommended first):
    1. label `"Add all relationships (Recommended)"`, description `"Add every relationship in one pass. Each is removable later if you change your mind. Best when the other modules are familiar."`
    2. label `"Review each one"`, description `"Walk through each relationship individually. Use when you're unsure about any of the targets, or when a relationship touches a sensitive shared module."`
    3. label `"Skip them all"`, description `"Deploy the module without any of these relationships. They'll come back next deploy unless you remove them from the design first."`

> **Fast flow, after the go-ahead:** 1 to 3 proposals or 4 or more, no printed list, no confirmation, no `Q:` task, and no question: apply all of them (they are exact matches already); log it with `log_pick modeler`; don't ask.

**On `Apply all`**, Stage 4h executes every Proposed row without further prompts.

**On `Review each one`**, create one `Q:` task per proposal (`Q: Add the relationship from <FK Table Label> to <References Label>? (<i> of <N>)`, yes / skip), asked in batches of up to four per call until the ledger is clean; then Stage 4h executes only the accepted ones.

> **Fast flow, after the go-ahead:** never reached, because a fast run applies all the proposals.

**On `Skip all`**, Stage 4h is a no-op. The dormant rows and the explicitly-skipped ones are noted in the verification summary so the user knows nothing was wired up.

This flow is **distinct from the 🛑 ambiguity protocol below for entity name collisions**. Entity-name ambiguity gates are blockers; the deploy cannot proceed until the user picks merge / rename / etc. Relationship proposals are not blockers; skipping them lets the deploy proceed unchanged. Keep the two flows separate.

### No ambiguity widgets at the modeler layer

The modeler does NOT drive `AskUserQuestion` widgets for cross-module collisions, similar-name flags, master promotions, or merge / rename decisions. Every such decision is already encoded in the spec as a `**Reconciliation:**` annotation. If Stage 2 detected drift (an annotated `reuse-from` target is missing, a `rename-incoming-from` target name now exists, a `promote-to-master` host module is missing or wrong type), the modeler halts and routes the user back to the analyst — it does not try to re-decide.

**The only confirmation the modeler asks** (in guided and expert flow) is the final pre-execute yes/no after the plan summary:

> *"Plan shown above. Proceed with deployment?"*

> **Fast flow, after the go-ahead:** don't render the plan; the go-ahead was this confirmation. Proceed to Stage 4 and log one line, "Deploy plan applied as prepared", with `log_pick modeler`; don't ask.

A `select_rule` create / modify or an `edit_permission` tier flip still pauses for explicit confirmation in guided and expert flow (medium-risk: read-visibility or write-tier change; standalone questions, not ledger tasks, like the pre-execute yes/no, the 4e-merge conflict prompt, and the 4f live-present prompt in Stage 4). So does an orphan workflow permission that Stage 1 flagged (a restricted-step permission no rule uses): one standalone question, create it anyway or send the design back to the analyst (`conflict-resolution.md`). These are the only mid-flow prompts.

> **Fast flow, after the go-ahead:** an orphan workflow permission is created as designed; log it with `log_pick modeler`; don't ask.

**A tier flip** is any change to who can edit an existing entity: its live `edit_permission` differs from the spec's code, or §9.1 includes its write permission in a different bundle than live does. The deployer adds the new row and syncs the column. When a flip narrows access, confirming it also removes the old bundle's row to that write permission (Stage 4b; SKILL.md, no auto-deletion), and the confirmation question says so.

### Merge / rename rules (informational)

When the spec carries `rename-incoming-from <existing_module>.<existing_entity> as <new_name>`, the modeler creates `<new_name>` as a brand-new entity in this module. There is no `update_entity` rename — the existing entity stays where it is, untouched. The user has decided (via the analyst) that the two concepts are different and should silo.

When the spec carries `promote-to-master <master_module>.<entity>`, the modeler **reassigns the existing entity to `<master_module>`** via `update_entity` (changes `module_id` only: the entity's `slug`, underlying Postgres table, data, permission columns, and every `reference_table` pointer at it across the catalog stay byte-for-byte unchanged). Creates `<master_module>` if missing per the spec's `promotion_decisions` frontmatter. **No data migration, no FK rewires, no orphan tables, no renamed permissions**: this is a metadata-only operation in the catalog. An adoption (Stage 2d) needs nothing else: the old module keeps its access through its own bundle rows. Only a shared-module move also seeds the master's `<master>_manager` role from the original module's `<original>_manager` members and applies the recorded `manage_option` (Stage 4i).

When the spec carries `reuse-from <module>.<entity>` for a master/shared entity, the modeler adds a `permission_hierarchy` row `<consumer>:read` → the entity's live `view_permission` (always, idempotent) and `<consumer>:manage` → its live `edit_permission` (if the spec's §9.1 says so).

---

### Family plan lines

When the spec has `is_a` / `has_a` entities, the plan shows the creation levels and each family in plain words (Writing Convention 8: never `is_a`, `has_a`, `base`, `subtype`):

```
  📦 Created in order: Business Partners, Activities (first) → Customers, Emails (then)
  🧬 Customers: something a Business Partner can also be (shares its record and id)
  🧬 Emails: a kind of Activity (listed with every activity)
```

A base in another module adds `🔗 Writers of Customers also edit Business Partners in CRM` (the cross-module edit grant).

## Gate A: pre-write planned-state integrity check (fires here, in Stage 3)

**Gate A: pre-write planned-state integrity check.** Fires in Stage 3, before any Stage 4 writes. Build the full intended end-state object graph in memory and verify internal consistency:

- Every planned FK target exists or is being created in this run.
- Every `**Based on:**` base is live or created in this run **at an earlier level** (no cycle), and no based entity carries a label column, label parent or order column.
- Every role member is a real user.
- No circular permission hierarchy. (Load-bearing: the design adds rows from a bundle to a per-entity permission and from a write permission to its read, which can't cycle. A row in the other direction would, and this check catches it.)
- Every default-role slot in every module's scaffold has a planned role (not checked under `access_scope: custom`, where the scaffold is skipped).
- Every cross-module inclusion has both its including and included permission (by `permission_name`) planned or live.
- Every code on an entity's `**View permission:**` and `**Edit permission:**` lines names a permission planned or live.
- Every merged JSON entry has a `source_module` value.

If any check fails, surface as a 🛑 with the broken reference quoted. Catches design bugs before they touch the catalog.

> Gloss: a `merged JSON entry` and its `source_module` tag are defined in `references/stage-4-execute.md` (sub-stage 4e-merge). This gate only asserts the planned end-state graph carries a `source_module` value; it does not need the merge mechanics, which run later in Stage 4.

