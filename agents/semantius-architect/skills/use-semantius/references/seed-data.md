# Seeding sample data

_Read this before writing any generated rows: sample data after the user said yes to the question in `build-module.md`, or any request to insert made-up records. Real records from a file go through the `semantius-importer` skill._

One script writes everything. It uses `seed-lib.ts`, which checks every row against the platform's description of its table before anything is sent and checks the result afterward, so the mistakes that matter cannot pass unnoticed: a missing or misspelled column, an empty required field, an enum label sent as its value, a row past an approval without its stamps, a child pointing at the wrong parent, a short insert, a wrong count, a figure out of scale with its child rows, a computed column that never moves.

## Set up

```bash
mkdir -p .tmp_deploy
# <skill-folder> = the directory this skill's SKILL.md was read from (absolute path)
cp "<skill-folder>/references/seed-lib.ts" .tmp_deploy/seed-lib.ts
bun .tmp_deploy/seed-lib.ts --describe <table>,<table>
```

`--describe` reads the tables from the platform and prints, for each one, what a seed sends:
- the key to use;
- every field with its format, whether it is required and its default;
- the values of each enum;
- the columns the platform writes, which the seed never sends;
- the approval stamps, with the states they go in.

Write the script from that output; column names, enum values and the key come from the platform, never from memory.

Never retype `seed-lib.ts` and never read it: the functions are listed below. No other write path: no hand-run `postgrestRequest` inserts, no probe or test rows.

## Run

Write the script as `.tmp_deploy/seed_<module_slug>.ts` and run it from the repo root by path (`preflight.md`):

```bash
bun run .tmp_deploy/seed_<module_slug>.ts
```

One command runs the script twice. First comes a check pass: it records every write and sends none, reads the tables, and checks every row. Only when the check pass passes does the real pass run, building the same rows and writing them. A halt in the check pass sent nothing; its output says `SEED HALTED in the check pass` and names the script line. `--check` runs the check pass alone and ends `CHECK RUN passed … nothing seeded`, which is not a seed. If `semantius` is not found, put its folder on PATH in the same command (`cli-usage.md` § "Installing from an agent").

To change your own script after a halt, change only the lines the halt names, with your file-edit tool or `edit-file.ts` (`cli-usage.md` → "Ad-hoc JSON and file work in Bun"); never write the whole script again.

## The pattern

```typescript
import { seedEnsureMany, idsByKey, assertParents, assertStatesAgree, assertComputedVary, assertSeedCounts, assertSeedDistinct, days, exampleDomain, rng, runSeed } from "./seed-lib";

await runSeed(async () => {
  const counts: Record<string, number> = {};

  // The plan comes first. It names each contract's parent by label and fixes its state; the rest follows from them.
  const plan = [
    { contract_name: "Adobe Creative Cloud for Teams", vendor: "Adobe",   state: "active" },
    { contract_name: "Figma Organization",             vendor: "Figma",   state: "active" },
    { contract_name: "Datadog Pro Trial",              vendor: "Datadog", state: "renewal_pending" },
    { contract_name: "Adobe Acrobat Pro",              vendor: "Adobe",   state: "expired" },
  ];

  // vendors. Drivers: the vendor name (→ website, support email at an example.com subdomain).
  const vendorRows = [
    { vendor_name: "Adobe",   website: "https://www.adobe.com",     support_email: `support@${exampleDomain("Adobe")}` },
    { vendor_name: "Figma",   website: "https://www.figma.com",     support_email: `support@${exampleDomain("Figma")}` },
    { vendor_name: "Datadog", website: "https://www.datadoghq.com", support_email: `support@${exampleDomain("Datadog")}` },
  ];
  assertSeedDistinct("vendors", vendorRows, ["vendor_name"], vendorRows.length);
  // vendors.contract_count is a rollup that counts contracts, so vendors get different numbers of contracts.
  assertSeedDistinct("contracts per vendor", vendorRows.map((v) => ({ contracts: plan.filter((p) => p.vendor === v.vendor_name).length })), ["contracts"], 2);
  counts.vendors = (await seedEnsureMany("/vendors", vendorRows, "vendor_name")).length;   // keyed on the label column
  const vendorId = await idsByKey("/vendors", "vendor_name", vendorRows);   // label → id, read back from the platform

  // contracts. Drivers: the vendor (→ vendor_id) and the state (→ end_date, notes).
  const r = rng("contracts");
  const contractRows = plan.map(({ contract_name, vendor, state }) => ({
    contract_name,
    vendor_id: vendorId(vendor),                                          // throws on a label that was not seeded
    workflow_state: state,
    end_date: state === "expired" ? days(-r.int(15, 120)) : days(r.int(30, 400)),   // in the past only when expired
    notes: state === "expired" ? "Not renewed." : state === "renewal_pending" ? "Renewal quote requested." : "Renews automatically.",
  }));
  counts.contracts = (await seedEnsureMany("/contracts", contractRows, "contract_name")).length;
  await assertParents("/contracts", "contract_name", "vendor_id", contractRows, plan.map((p) => p.vendor));

  // Last, when every table has landed: the computed and rollup columns, then the counts. contract_count is never sent in a row.
  await assertComputedVary("/vendors", "vendor_name", vendorRows, ["contract_count"]);
  assertSeedCounts(counts, { vendors: 3, contracts: 4 });                // the counts the question named
});
```

## The functions

- `seedEnsureMany(path, rows, keyField)`: the insert for every table, a junction included.
  - **The key.** `keyField` is the table's label column when the seed sends it. When the platform computes the label, or the table is a junction, use `"_ref"`: every planned row carries a `_ref` name that is never sent, and stored rows are found by the values the rows send. `--describe` names the key for each table.
  - **What it does.** It checks the rows before anything is read or sent. It reads the rows already stored under those keys, halts when one of them differs from its planned row, inserts the missing ones in one POST, and returns all rows with their ids (and their `_ref`) in input order.
  - Use it only on entities this build created.
- `postMany(path, rows)`: a plain bulk insert, with the same checks. A re-run appends a second set, so a seed uses `seedEnsureMany`.
- `idsByKey(path, keyField, rows)`: returns `(key) => id`, read back from the platform by the same key as the insert (the label, or the `_ref`). It halts on a key that is missing or appears twice. Its `.labelOf(key)` gives the parent's stored label, for a parent whose label the platform computes.
- `assertParents(path, keyField, fkField, rows, parentLabels)`: reads the child rows back with their `<fk>_label` and halts, naming the rows, if one names a different parent than `parentLabels[i]` (`null` for an optional relationship meant to be empty).
- `assertJunction(path, fkA, fkB, pairs)`: for a connecting record. It reads the whole table back with both `<fk>_label` columns. It halts on an intended `[labelA, labelB]` pair that is missing or wrong, and on a stored row that was not intended.
- `assertStatesAgree(name, parents, rules)`: before the first write, for a parent table and a child table that both carry `workflow_state`.
  - Each entry is `[parent label, parent state, child states]`; a parent keyed on `_ref` is named by its `_ref`.
  - `rules` maps a parent state to the child states it allows (`only`, `[]` for no child rows) and the child states it needs one of (`needs`).
  - It halts, naming the parents, when a parent's state and its children's states disagree, or when a rule names a state no parent has.
- `assertStamped(path, keyField, rows, columns, states)`: for an entity with an approval gate, at the end of the script. It proves, by reading the rows back, that the entity's rules kept the stamps the rows sent.
- `assertComputedVary(path, keyField, rows, columns)`: reads `computed` and `rollup` columns back for the seeded rows and halts when a column holds one value on every row. A `$user_id`, `$now` or `$today` stamp that holds this run's user, time or date on every row is constant by design: it is left out with a printed line, not a halt.
- `assertItemized(column, parents)`: before the first write. Each entry is `[parent label, figure, number of child rows]`, as in `assertItemized("subscriptions.seats_purchased", plan.map((p) => [p.name, p.seats_purchased, p.seats.length]))`. It halts, naming the parents, when a figure is below its child count or above twice it.
- `assertSeedCounts(counts, expected)`, `assertSeedDistinct(table, rows, columns, minDistinct?)`: halt on a wrong count, or on a column that should vary and does not.
- `readRows(path)`: reads rows of an existing entity the seed points at, such as `users`: `await readRows("/users?select=id,display_name&limit=20")`. A read, never a write.
- `seedUser()`: the user running the seed, `{ id, permissions }`. That user is the requester of every row it inserts, so never the approver of one.
- `patchById(table, id, body)`: fixes one row.
- `clearSeeded([[path, count], …])`: empties tables, children first, after checking that each holds `count` rows. See "Changing what was seeded".
- `rng("<table>")` with `.pick(pool)`, `.int(min, max)`, `.chance(p)`, `.deal(pool, n)`, `.distinct(pool, n)`, `.tuples(n, [poolA, poolB])`: the only source of random values in the script, never `Math.random()` or a helper of your own. Every stream restarts at the start of each pass, so both passes, and an unchanged script run again, draw the same values.
- `days(n)` (a date n days from today), `at(n, "HH:MM")` (a date-time n days from today at that UTC time), `uniq("INV-", i)` (a code-like field the model already has), `exampleDomain(company)`, `slugify(text)`. Never build a value from `Date.now()` or the clock: the real pass would write other values than the check pass checked. The real pass halts when its keys or row counts differ from the check pass; other values are not compared.
- `runSeed(async () => { … })`: wraps the script, runs the check pass and then the real pass, and exits non-zero on any thrown error, printing `SEED HALTED` with the script line.

What the checks before a write cover:
- **Columns.** Every column is a field of the table. An `id` goes only on a `bigint`, `text` or `has_a` key. No column the platform writes is sent (computed, rollup, `created_at`, `updated_at`), except an approval stamp on a row past its step.
- **Values.** A required field has a value, including one its `input_type_rule` makes required for that row. A required field that is not sent has a default. An enum gets one of its values, never a label. `null` goes only on a reference, date or date-time.
- **Approval stamps.** A row at or past an approval carries its stamps. Its approver is not the user running the seed, that user is the module's admin, and that user may create the records and read them all back.
- **Shape.** Every row has the same keys, every email address is at a subdomain of example.com, and no column starts with `_`.

Never add a field to the schema to key or ease a seed.

## Parents and children

- Parents first, children after. A child names its parent by its key in the plan, and `idsByKey` turns the key into the id. Never type an id, never map by array position, never take an id from an insert response (`SKILL.md` → "Response handling").
- Give every parent its own label or `_ref`. `idsByKey` halts on a repeated key or a key it cannot find.
- After each child table, `assertParents` reads the rows back with their `<fk>_label` (`crud-tools.md` § "Composed labels") and compares each with the parent from the same plan. A mismatch halts and names the rows; fix them with `patchById`.
- A parent whose label a rule composes (an enrollment, labeled from its student and course) is keyed on `_ref`, because the seed never sends that label. Give `assertParents` the label `idsByKey` read back, one per child row: `gradePlan.map((g) => enrollmentId.labelOf(g.enrollment))`, where each grade in the plan names its enrollment by its `_ref`.
- A child whose label repeats across parents (one person holding seats on two subscriptions) is keyed on `_ref` too.
- A connecting record (junction) is keyed on `_ref`, each row carrying the ids of its two parents from their `idsByKey` lookups, so a re-run after a halt converges. Keep the intended `[labelA, labelB]` pairs in the plan, and check them with `assertJunction` instead of `assertParents`:

  ```typescript
  const seatPairs = [["Slack", "Maria Lopez"], ["Figma", "Tom Becker"]] as const;
  await seedEnsureMany("/seats", seatPairs.map(([app, person]) => ({ _ref: `${app} + ${person}`, application_id: applicationId(app), user_id: personId(person) })), "_ref");
  await assertJunction("/seats", "application_id", "user_id", seatPairs);
  ```
- A required relationship into an existing entity (such as `users`): read that entity once with `readRows("/users?select=id,display_name&limit=20")`, choose rows from that read, use each chosen row's own `id`, and name that row's label in `parentLabels`. Never a bare list of ids.
- An optional relationship that is empty on a row is `null` in the row and `null` in `parentLabels`.
- A family (`is_a` / `has_a`):
  - An `is_a` record is inserted once, at its own table, with the base's fields in the same row; never a base row and then a subtype row.
  - A `has_a` row without `id` creates its base record too. With the `id` of an existing base record, it attaches and carries only the extension's own fields (`entity-families.md` → "Writing").

## One call per table

- Every table goes through one `seedEnsureMany` call: one POST for the whole table. Every row carries the same keys; an empty value is `""` (text, email, url, …) or `0` (numbers), and a column you leave out of every row takes the platform's zero value.
- Tally each table from its own insert (`counts.vendors = (await seedEnsureMany(…)).length`) and end with `assertSeedCounts` using the per-table counts the sample-data question named. A lower count needs a stated reason in the report.
- After a halt in the real pass, fix the cause and run the script again: `seedEnsureMany` finds the rows that landed by their key and skips them. When a stored row no longer matches the plan (a value or a key was changed in the script), the check pass halts and names it; see "Changing what was seeded".

## Values

- A `rating` is an integer from 0 to 5 (1 to 5 when required).
- An `icon` is a Lucide name from `lucide-icon-finder.ts` or the "Enum icons" table in `data-modeling.md`, and passes `lucide-icon-checker.ts` before it is written.
- Other formats: `data-modeling.md` → "Field Format Quick Reference".

## Rows that read as records

- Decide where each chain of records stands first: the state each parent ends in, and the states of its children that agree with it. An application at `hired` has an `accepted` offer; an application at `applied` has no offer. The plan holds each parent with its children and their states. When a parent table and a child table both carry `workflow_state`, check the plan with `assertStatesAgree` before the first write, with a rule for each parent state that limits its children:

  ```typescript
  assertStatesAgree("applications.offers", plan.map((a) => [a.name, a.state, a.offers.map((o) => o.state)]), {
    applied: { only: [] },
    offer: { needs: ["approved", "sent"] },
    hired: { needs: ["accepted"], only: ["accepted"] },
  });
  ```
- Then decide each row's drivers (its state, its parent, its place) and derive every field that must agree with them:
  - a terminal state (revoked, canceled, expired, closed) gets a note that says so or no note, never an ongoing one such as "still billing";
  - an active state never gets a note about ending;
  - an end date is after its start date;
  - a closed date exists only on a closed row.
- A parent's stored figure that its child rows itemize (a number a person enters, such as seats purchased over seat rows) stays at the scale of those rows, since a small dataset cannot carry a real company's numbers.
  - The range is at least the number of child rows and at most twice that: with 3 seat rows, 3 to 6 seats purchased, never 120.
  - Set the figure in the plan next to the parent's children, vary the gap between parents (none on one, a few on another), and check the plan with `assertItemized` before the first write.
  - A figure the platform counts from the child rows is a `rollup`, not a stored figure: it needs no such check and is not in the plan.
- Give parents different numbers of children (1 to 5, about 3 on average), never the same number each: a rollup that counts them would be identical on every parent and halt the run. Check it before the first write with `assertSeedDistinct` over the per-parent counts, as the example does.
- When a computed or rollup column depends on a state of the children (inactive seats, overdue invoices), give some parents children in that state and others none, so the column differs between parents.
- Spread every enum across its values: set the state in the plan, or use `r.deal(values, n)` so every value appears before any repeats. Then derive from it, as above.
- Text that names another record (a title or summary that mentions its parent) is built from the parent in the plan, never drawn separately.
- Nothing a person reads is a base plus an index (`100 + i`, `Slack 0`, `days(-7 * i)`). Write it or draw it (`r.int`, `r.pick`). An index belongs only in a code-like unique field the model already has, through `uniq("INV-", i)`.
- Names, cities and companies vary. `assertSeedDistinct(table, rows, [columns])` fails when a column that should vary does not; use `r.tuples` for names built from two pools.
- Real company and product names are fine.
  - Every email address is at a subdomain of `example.com`, which never receives mail. Build it with `exampleDomain(company)` (`support@adobe.example.com`), never with the company's real domain; the insert refuses any other address, in any text column.
  - A US phone uses `555-0100` to `555-0199` behind the area code; a phone in any other country stays empty.

## Computed and rollup columns

Every `computed` and `rollup` column of a seeded table goes through `assertComputedVary`, at the very end of the script, immediately before `assertSeedCounts`. That includes every column a `computed_fields` rule names, a composed label among them. Pass them all: a `$user_id`, `$now` or `$today` stamp that is constant on a seed is left out by the function itself, which prints a line for it to name in the report.

```typescript
await assertComputedVary("/subscriptions", "subscription_name", subscriptionRows, ["used_seats", "wasted_annual_cost"]);
```

A table keyed on `_ref` passes the rows `seedEnsureMany` returned and the key `"_ref"`: `await assertComputedVary("/seats", "_ref", seats, ["annual_cost"])`.

A `computed` or `rollup` column never goes in a row and is never patched: the platform writes it and overwrites what you send. Change its inputs instead. The one exception is an approval stamp on a row seeded at or past its step.

**Approval stamps on rows past the step.** A row seeded straight into a state at or past an approval (`approved`, `ordered`, `signed`) carries its `<step>_by_user_id` and `<step>_at` in the row, because the rule keeps what an insert sends there (`rbac.md` → "Controls on a gate", control 5).
- **The date** follows from the plan and falls after the row's own earlier dates (`at(n, "HH:MM")`).
- **The approver** is the user the record names as its approver (`approver_user_id`) when it names one. Otherwise it is a user read from `users` other than the user running the seed (`seedUser()`), since that user is the requester of every row it inserts and a requester never approves their own record (see "Parents and children" for a relationship into an existing entity).
- **A row before the step** sends `null` in both.
- **The check pass** halts on a row past the step without its stamps, on an approver who is the user running the seed, and on a seed user who does not hold `<slug>:admin`, because only an admin may create a record at or past an approval (`rbac.md` → "Restricted steps (gates)", step 5).
- **At the end of the script,** before `assertComputedVary`, prove the rules kept them: `await assertStamped("/offers", "_ref", offerRows, ["approved_by_user_id", "approved_at"], ["approved", "sent", "accepted"])`.
- **When the seed user is no admin, or is the only user,** seed no row at or past an approval step, leave its stamps out of `assertComputedVary`, and say in the report why no sample record is past the approval.

A column with one value on every row halts the run. Fix the inputs in the plan, clear the seed and write it again (next section).
- **Constant by design** means the formula gives the same value for every possible row, or a `$user_id`, `$now` or `$today` stamp such as `requested_by_user_id`, which a seed run writes as one user, on one day. `assertComputedVary` leaves such a stamp out by itself.
- **Never constant by design:** a column that came out 0 on every row, and an approval stamp, which the seed sends.
- **Leaving a column out yourself** is only for a formula that is constant for every possible row, or for the approval stamps when no row is past the approval (above), never because it halted. Name every column left out in the report.

## Changing what was seeded

`seedEnsureMany` never changes a row that is already there. It reads the whole table: when a stored row differs from its planned row, or matches no planned row at all (a value or a key was changed in the script after a run landed it), the check pass halts and names it. Numbers are compared rounded to their field's precision, as the platform stores them. To correct one or two rows, use `patchById` on their input columns and run again. To change a table's numbers, clear the tables and seed again:

```typescript
import { clearSeeded, runSeed } from "./seed-lib";

await runSeed(async () => {
  await clearSeeded([["/contracts", 4], ["/vendors", 3]]);   // children first, each with the count it holds
});
```

Write it as `.tmp_deploy/clear_<module_slug>.ts` and run it the way the seed script runs, with one command. It ends `Clear finished`, which is not a seed. Then run the seed script.

- Only on entities this build created, and only during the build that seeded them. Later, clear a table only when the user asks: by then it may hold real records.
- List children before parents, and connecting records before either. A `restrict` relationship refuses the parent's delete, and a `cascade` relationship removes the child first, which halts the run.
- A validation rule can refuse a delete (a gate on a terminal state, for example), and a check pass cannot see that because it sends no delete. When a delete is refused, stop and tell the user. The tables listed before it are already empty.
- An `is_a` family:
  - When the build created the family whole, it is cleared at its root, whose count covers the records of every subtype.
  - When the build created only a subtype on an existing base, list the subtype's own table and never the root: a delete there removes the whole record, and the root also holds records this build did not write.
  - Never list a subtype together with its root. A `has_a` table goes before its base.
- **Each count** is the number of rows the seed wrote to that table: the count the last real pass reported or, after a halted run, the sum of its `✓ POST` lines for that table.
  - Every table is counted before the first delete, and a count that differs halts with nothing deleted. A difference means rows the seed did not write: stop and tell the user.
  - Never copy the number from the error into the script.

## Report

Report a seed only from the real pass's output. It ends `Seed finished: <n> write call(s) applied with no errors.` and shows:
- every table at its count;
- a `✓ <table>.<fk>: all <n> row(s) name the intended parent` line for each child table (`… name the intended parents` for a connecting record);
- a `✓ <name>: <n> parent(s) agree with their children` line for each `assertStatesAgree`;
- a `✓ <table>: all <n> row(s) past the step carry …` line for each `assertStamped`;
- a `✓ <table>.<column>: <n> distinct value(s)` line for each computed or rollup column. A one-row table prints `one row, so … cannot be compared` instead, and a stamp left out prints `… constant by design: left out of the check`.

State how many rows landed in each table, and name every column left out as constant by design. A run that ended `CHECK RUN passed`, `SEED HALTED` or `Clear finished` seeded nothing you can report. Do not summarize the data's meaning: that is analytics, which is a separate request.
