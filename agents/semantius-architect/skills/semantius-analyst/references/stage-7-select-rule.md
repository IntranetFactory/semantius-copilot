# Stage 7: Row-level read-access scan (select_rule)

*Reference for `semantius-analyst` (Stage 7).*

Read: `../../use-semantius/references/select-rule.md` — the `select_rule` contract (REPLACE-vs-AND semantics, `has_permission`, performance limits).

## Stage 7: Row-level read-access scan (`select_rule`)

> **Access-level short-circuit.** Under `access_scope` `basic` and `custom`, this stage emits **nothing** — no `select_rule` on any entity (table-level `view_permission` is the only read gate). Skip to Stage 8. Under `advanced`, `gated` and `raci` it runs as documented. (See the "What each access level authors" contract in SKILL.md.)

For each entity, scan for row-visibility patterns:

- **S1 — Ownership scope (row-scope playbook).** Entity has an owner FK to `users` (`created_by` / `owner_id` / `submitter_id` / `assignee_id` / `author_id`). Decide between two shapes per entity, guided by the §1 / §3 prose and any `## Additional Requirements Specification` directive — **this decision is the analyst's; the blueprint carries no flag for it:**
  - **(a) Private** — the row belongs to its owner alone, with no oversight (bookmarks, saved searches, personal drafts / notes). Emit a `select_rule` scoping to the owner column with **no `has_permission` disjunct** and **no override permissions**. The owner is the only one who ever sees the row.
  - **(b) Owner + oversight** — the owner sees their own rows by default, but a manager / admin must be able to see all (tickets, applications, interview scorecards, offers). Emit a `select_rule` with an `or($user_id == owner, has_permission(<owner>:view_all_<plural>))` disjunct **and** emit the `<owner>:view_all_<plural>` (read) + `<owner>:manage_all_<plural>` (write) override permissions in §8.1 as `override`-tier rows, rolled up under `<slug>:admin` in the §9.1 permission hierarchy. `<owner>` is the entity's `mastered in` module, or this module when it masters the entity.

  **Default when the prose is silent:** owner + oversight for operational entities a team works (tickets, tasks, cases); **private** only when the data is unambiguously personal, or the `## Additional Requirements Specification` says so.

  **⚠ REPLACE-semantics trap — read before authoring either shape.** A `select_rule` is the *complete* row-visibility predicate: the platform applies it INSTEAD OF the default "everyone with `view_permission` sees every row," not on top of it. There is no implicit "but admins still see all" underneath. So the `has_permission(<owner>:view_all_<plural>)` disjunct is the **only** thing that grants oversight — omit it on data you meant to be oversight-visible and you silently lock admins (and everyone else) out; add it on data you meant to be private and you silently mint snoop permissions you didn't want. Pick (a) or (b) deliberately per entity; never add `view_all_` "to be safe."

  **Unassigned rows.** Under (b), when the owner relationship is optional (§5.2 `field_required` `no`), a row can have no owner, and the plain rule hides it from everyone but `view_all_` holders. Add one disjunct so the people who work the entity can see and assign it: `and(owner == null, has_permission(<the entity's edit_permission>))`. Keep the `has_permission` guard: under the REPLACE semantics above, a bare `owner == null` disjunct shows the row to every caller, including users with no role in this module. Stage 10 F7 carries the matching write branch. This follows from the relationship's `field_required`, so never ask. It does not apply to (a), or to a required owner relationship.
- **S2 — Confidential flag.** Entity has an `is_confidential` boolean → rule hides confidential rows unless caller holds `<owner>:view_confidential_<plural>`.
- **S3 — Department / team scope.** Entity has a `department_id` / `team_id` → rule scopes per caller's department / team membership.
- **S4 — Public vs internal.** Entity has a `visibility: enum` with values like `public` / `internal` / `private` → rule respects the visibility.
- **S5 — No rule.** Most operational entities default to no `select_rule` (RLS off); table-level `view_permission` is the only gate.

Output: per-affected entity, a `**Select rule**` JSON object.

```json
{
  "or": [
    {"==": [{"var": "$user_id"}, {"var": "owner_id"}]},
    {"has_permission": "<owner>:view_all_<plural>"}
  ]
}
```

With an optional owner relationship (`<edit_permission>` is the entity's own `**Edit permission:**` code):

```json
{
  "or": [
    {"==": [{"var": "$user_id"}, {"var": "owner_id"}]},
    {"and": [
      {"==": [{"var": "owner_id"}, null]},
      {"has_permission": "<edit_permission>"}
    ]},
    {"has_permission": "<owner>:view_all_<plural>"}
  ]
}
```

**Warning posture.** The deployer pauses for explicit confirmation on every `select_rule` create / modify / remove — read-visibility changes are medium-risk (rows that callers used to see suddenly disappear).

**Bypass-prose × JsonLogic cross-check.** If the entity description or the rule's `description` contains bypass-shaped phrases (*"holders of X see all"*, *"unrestricted for managers"*) and the JsonLogic body doesn't literally reference that permission token, fail Stage 8 consistency check.
