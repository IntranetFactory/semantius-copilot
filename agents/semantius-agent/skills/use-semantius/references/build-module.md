# Building a module from a request

_Read this when the user asks you to build or set up something new that needs its own records, however it is phrased: a module, app, platform, system, tracker or tool, or "a way to see and manage X" ("build my SaaS management platform", "set up a vendor tracker", "I need a way to track renewals"). Adding a field, entity or permission to an existing module is not a build._

A build request means: create the module, its entities, fields, relationships, permissions and roles, then return the UI links. It does not mean a large sample dataset, a spec, a diagram, CSV exports or an analytics report. Deliver the smallest result that satisfies the request; the user asks for more when they want more.

## Default deliverable

1. The module with its entities, fields and relationships, modeled like the leading products when the domain is well known, and created in the order below.
2. The module's permissions, permission hierarchy, roles and default-role wiring (`rbac.md`). They are part of every module, never an extra.
3. Sample data, only after the user says yes (next section).
4. One verification read of the new entities (see "Verify, then stop").
5. The final response (see "Final response").

## Model it like the leading products

When the request is similar to a well-known domain, the module follows how the leading products of that domain model it, not an invented shape. When it is not (a one-off internal process, a niche tool no product category covers), skip this section and model from the user's description. Before the first write:

1. **Pick two or three leading products** for the domain (a SaaS management platform: Zylo, Flexera, Productiv; a service desk: ServiceNow, Jira Service Management; a CRM: Salesforce, HubSpot). Look up how they structure it; do not answer from memory when a search is available.
2. **Take their shape:** the set of records, the fields a user expects on each, the lifecycle states, and the roles that use it. Keep what two or more of them agree on; skip what only one has unless the user needs it.
3. **Name things their way.** Convert each followed product's record and field names with `vendor-names.ts` (`SKILL.md` → Reference Files), never by hand.
4. **Build only what the user's goal needs.** The products are the benchmark for naming and structure, not a feature checklist. Leave out modules of theirs the request does not touch.
5. **Say what you followed.** The final response names the products used as the reference and any deliberate difference.

Each field, entity and permission is then created under the rules that already govern it (`SKILL.md` → Quick Decision Guide); this file adds no second set of rules for them.

## Order of a build

1. Outline the entities, after picking reference products when the domain is well known (above).
2. Settle any choice locked at creation (next section).
3. Confirm the scope, only when more than 4 entities are relevant (after that).
4. Ask the sample-data question, with the exact total for the confirmed scope. Every question is asked on its own, one at a time, and the build waits for each answer.
5. Create the module in the order of `data-modeling.md` → "Mandatory Creation Order": module, permissions, module wiring, permission hierarchy, roles, grants, default-role wiring, entities, fields.
6. Seed the sample data, when the user said yes.
7. Verify, then answer (below).

No write happens before step 5.

## Settle choices locked at creation

An `is_a` / `has_a` family, or a separate entity instead (`entity-families.md`), cannot be changed after creation. When the outline contains such a case, confirm it with the user as its own question before anything is written. Nothing else about the model is asked.

## Confirm the scope when it is large

When more than 4 entities are relevant, the user confirms the entity list before the first write. At 4 or fewer, build without this question.

- Put the list in the question as running text, the entities' plural labels separated by commas, with a short clause only for an entity whose purpose is not obvious. No bulleted list and no line per entity.
- Options: build all of them, build only the core ones (name them in the question), or adjust the list.
- The confirmed list is the build scope. Entities left out go under next steps in the final response.
- With no answer (a non-interactive run, or no reply), build the four most central entities and list the rest as next steps.

## The sample-data question

Ask it with `AskUserQuestion`, in the question format the preflight sets (`SKILL.md` → "Environment Setup"). The consent rules below hold in every format.

Ask it as its own question, after the scope is settled and before the first write, and end the turn. Name the exact total for the confirmed scope.

> Should I add a small demo dataset so you can review the module, or leave the tables empty for your real data?
>
> - **Sample data (recommended)**: about \<M\> records across \<N\> tables (\<Plural Labels\>)
> - **Empty tables**: nothing is seeded

Consent rules. Sample data is never written without an explicit yes to this question:

- **Ask, then stop.** Do not build the seed rows, run anything, or prepare to seed in the turn that asks.
- **A request that already asks for demo data** ("with a small demo", "with realistic data") does not skip the question: it is still asked, with the exact total, so the cap and the total are shown.
- **A clear yes is consent.** "yes", "sample data", "go ahead and create the sample data", and a plain "ok" or "sure" in answer to this question are consent. A reply that names counts ("10 each", "20 vendors") is consent and sets those counts.
- **Not consent:** `continue`, `proceed`, `next`, a thumbs-up, silence, or a yes that arrives bundled with an unrelated instruction. A count in the same reply beats a continuation word ("ok, but 30 vendors" seeds).
- **Default is no.** An ambiguous reply, a topic change or a non-interactive run seeds nothing. Re-ask the single question when in doubt.

## Sample-data size

| Entity kind | Rows |
|---|---|
| Parent, catalog and reference entities | 5 to 10 |
| Child entities (lines, seats, licenses, renewals) | about 3 per parent row, at most 20 per entity |
| Connecting records (junctions) | at most 20 |
| People rosters | at most 10 |

- Five parents give 15 to 20 children, not one child per real-world item. A 500-seat company still gets about 20 rows.
- A larger dataset is created only when the user names a row count or asks for volume testing (a company size such as "500 people" is not a row count); state the number in the question.
- Realistic labels, not hundreds of synthetic records. Spread every enum across its values, vary names, companies and cities; a column that repeats one value on every row reads as a defect.

Which tables get rows:

- Only entities this build created. Never write sample rows into an existing entity.
- Never into built-in tables: `users`, `roles`, `permissions`, `permission_hierarchy`, `role_permissions`, `user_roles`, `modules`, `entities`, `fields`, `webhook_receivers`, `webhook_receiver_logs`. Sample users cannot sign in and pollute the audit trail.
- A required relationship into an existing entity takes a real id read from that entity (`GET /users?select=id&limit=20`), never an invented record. When it has no rows, skip the field if it is optional, or seed fewer rows with a stated reason.

How to write them:

- Parents first, children after; take each parent's `id` from the insert response. An entity whose key type is `bigint` or `text` needs an `id` on every row.
- One `postgrestRequest` POST per table with an array `body` (Golden Rule 7). Rows in one array carry the same keys.
- No probe or test inserts. If a row violates a rule, fix the row, not the rule.

## Verify, then stop

After the build, verify once. The check catches the mistakes that matter: an entity left `unclassified` or a missing permission.

- **The module's entities:** one `read_entity` for all of them with `entity_type`, `view_permission` and `edit_permission` (`data-modeling.md` → "Agent Workflow Tips" → "Verify the class and the permissions after creating entities"). Fix what it shows and read again.
- **Only when sample data was seeded:** the row count per table, and with rollups one parent row to show the computed values. An empty module has no rows to check.

Then stop adding value.

Verification is not analysis. Do not run cube or aggregate queries "to show value". Analytics is a separate request: run it when the user asks what the data says (trends, top-N, waste, spend, anything else about the contents).

## Only when the user asked

Do none of these in a build unless the user asked for that artifact:

- a spec, a diagram, an export, or any CSV or report file
- dashboards, saved views, email reminders or scripts
- an analytics narrative

When the user did ask for one, produce exactly that, with the built-in tool (`SKILL.md` → "Find the built-in tool before building"), and nothing beside it. The tool's output is the artifact (`SKILL.md` Golden Rule 10): use it unchanged, with no hand-drawn companion diagram and no re-rendering in another style. "Build X and show me spend by category" is a build plus analytics. "Build X, then generate the spec" is a build plus the spec, and no reports.

## Final response

- One line: what was built, and, when the module follows leading products, which ones (with any deliberate difference).
- The UI links: the module (`{ui_baseurl}/{module_slug}`), then each entity list (`{ui_baseurl}/{module_slug}/{table_name}`). Take `ui_baseurl` from `getCurrentUser`, never hardcode the host (`SKILL.md` → "Linking to the web UI").
- When sample data was seeded: one line with the row counts per table.
- Two or three next steps, including any entities left out of the confirmed scope, such as "Add your first record", "Import a CSV", "Assign roles", "Ask me for a reminder when you want one".
- No "what the data says" section, unless the user asked for analytics.
