# Stage 10: Computed fields and validation rules

*Reference for `semantius-analyst` (Stage 10).*

Read: `../../use-semantius/references/jsonlogic.md` — the `computed_fields` / `validation_rules` contract (evaluation semantics, reserved variables, extension operators, cross-entity lookups).

## Stage 10: Computed fields and validation rules

> **Access-level note.** Under `access_scope` `basic` and `custom`, emit computed fields and validation rules as usual **except** any rule whose JsonLogic gates on a permission (`require_permission` / `has_permission`): the gating permission does not exist there, so drop that rule. Pure data-integrity rules (date ordering, required-when, range checks; no permission reference) are kept; they are not access control. Process gates (§7 gated states and §8.2 `create` rules) follow the access level: under `gated` and `raci` the rule checks the gate's own permission (its §8.1 `workflow-gate (lifecycle)` row) with `has_permission` (shapes and where each is written in "Gate rules" below); under `basic`, `advanced` and `custom` no gate rule is emitted. (See the "What each access level authors" contract in SKILL.md.)

Convert blueprint §8.2 business rules to JsonLogic, plus add field-level computed fields and validation rules discovered during Stage 4.

### Gate rules

Under `gated` and `raci`, every process gate gets one gate rule that checks the gate's own permission `<gate>` with `has_permission`. `<gate>` is the code exactly as the gate's §8.1 `workflow-gate (lifecycle)` row writes it, whichever module its prefix names. Where it is written depends on the RACI mode:

- **`gated`, and `raci` in `documentation` mode:** a §3 `validation_rules` entry on the gated entity.
- **`raci` in `living` mode:** a row of the §9.1 `_enforcement rules_` table only (Stage 9.5), which is the one home of the living-mode gate rules (transition A-gates, create A-gates, C-blocks). The analyst never also writes an A-gate into the entity's §3 `validation_rules`.

Under `basic`, `advanced` and `custom` no gate rule is emitted.

- **Transition into a gated §7 state**, under `gated` and under `raci` in `documentation` mode:

  ```json
  {"if": [
    {"and": [{"value_changed": "workflow_state"}, {"==": [{"var": "workflow_state"}, "<to_state>"]}]},
    {"has_permission": "<gate>"},
    true]}
  ```

  Under `raci` in `living` mode it is the A-gate, an `_enforcement rules_` row (Stage 9.5): the same `if`, with `{"or": [{"is_raci_actor": ["<entity>", "<to_state>", "accountable"]}, {"has_permission": "<gate>"}]}` as its middle branch.
- **A §8.2 rule with source flag `create`** (a restricted creation) applies on insert (`$old` is `null` only on INSERT): `{"if": [{"==": [{"var": "$old"}, null]}, {"has_permission": "<gate>"}, true]}`, where `<gate>` is the gate's own §8.1 `workflow-gate (lifecycle)` permission, under `gated` and under `raci` in `documentation` mode. Under `raci` in `living` mode it is the create A-gate, an `_enforcement rules_` row (Stage 9.5), so the Accountable role can do the restricted creation and the admin keeps the override: `{"if": [{"==": [{"var": "$old"}, null]}, {"or": [{"is_raci_actor": ["<entity>", "<initial state>", "accountable"]}, {"has_permission": "<gate>"}]}, true]}`, where `<initial state>` is the entity's `initial?` §7 state.
- **Code and message.** Each gate rule has its own `code` (the next in the spec's sequence) and its own `message` naming who may take the step. A §3 gate rule carries both; an `_enforcement rules_` row carries only its JsonLogic, and the modeler derives its `name`, `code` and `message` the same way when it authors the rule (modeler Stage 4k). The messages: under `raci` the Accountable role and an admin ("Only the hiring manager or an admin can approve an offer"), or the Accountable role alone on a high-risk gate ("Only the hiring manager can approve an offer"); under `gated` an admin ("Only an admin can approve an offer"). `has_permission` never throws, so the rule keeps its own `code` and `message` (the caller sees it instead of the platform's generic permission error) and the A-gate's `or` works in either branch order (`require_permission` throws on a miss; `../../use-semantius/references/jsonlogic.md`, "Choosing between `require_permission` and `has_permission`").

### Computed fields

A JSON array per entity. Each entry derives a value into an existing scalar field via JsonLogic, evaluated on every write.

```json
[
  {
    "name": "rice_score",
    "description": "(reach × impact × confidence) / effort.",
    "jsonlogic": {
      "/": [
        {"*": [{"var": "reach_score"}, {"var": "impact_score"}, {"var": "confidence_score"}]},
        {"max": [{"var": "effort_score"}, 0.1]}
      ]
    }
  }
]
```

Reserved variables: `$today`, `$now`, `$user_id`.

Cross-entity primitives: `{"set_record": ["<name>", "<entity>", <id_expr>, <body>]}` and `{"let": ["<name>", <value>, <body>]}` let the body read columns of a parent / referenced record. See `../../use-semantius/references/jsonlogic.md` § "Cross-entity lookups inside JsonLogic".

### Validation rules

A JSON array per entity. Each rule must evaluate truthy for the write to succeed. The first failing rule stops the write and returns its `code` as the error code and its `message` as the error text.

```json
[
  {
    "code": "99001",
    "name": "amount_positive",
    "message": "Amount must be positive.",
    "description": "Money never goes negative on this entity.",
    "jsonlogic": {">": [{"var": "amount"}, 0]}
  }
]
```

- **`name`**: snake_case, unique within the entity. The rule's natural key (drift detection, merge, audit findings).
- **`code`**: a class-99 SQLSTATE error code, exactly `99` followed by three digits (`^99[0-9]{3}$`); the platform rejects any other shape with `90905` and does not require uniqueness. Assign codes sequentially per spec starting at `99001`, in §3 entity order then array order, so every rule in the module has a distinct code the caller can branch on.

Platform-extension operators:
- `{"value_changed": "<field>"}` — true when field differs from `$old`, true on INSERT.
- `{"require_permission": "<permission_code>"}` — true when caller holds the permission, throws otherwise.
- `{"has_permission": "<permission_code>"}`: true when the caller holds the permission, false otherwise (never throws). Every gate rule uses it ("Gate rules" above).
- `{"throw_error": "<message>"}` inside an `if` — raises SQL exception with the message verbatim.

Every `require_permission` and `has_permission` argument must reference a permission declared in §8.1 Permissions catalog (Stage 8 enforces).

### Scan families

For every entity, mechanically walk these families and propose rules:

| Family | Trigger | Rule shape |
|---|---|---|
| F1 — Monetary positivity | `format: number` field with name `amount` / `price` / `cost` / `total` / `balance` / `revenue` / `fee` / `salary` / `budget` | `{">=": [{"var": "<field>"}, 0]}` |
| F2 — Date order | Two date fields `start_*` and `end_*` | `{"<=": [{"var": "start_*"}, {"var": "end_*"}]}` |
| F3 — Enum lifecycle | the `workflow_state` enum field with lifecycle states | `value_changed` + lifecycle ordering check |
| F4 — Required-when | `default: ""` required string conditional on another field's value | `if (other == X, value != "", true)` |
| F5 — Reference integrity | FK + condition that the target exists in a state | `set_record` lookup + state check |
| F6 — Submit lock | `is_submitted` boolean | `if (old.is_submitted, require_permission(:bypass_submit_lock), true)` |
| F7 — Owner edit | `owner_id` FK to users | `if (value_changed("x"), $user_id == owner_id OR has_permission(:edit_all), true)` (`has_permission`, since `require_permission` throws inside an `or`). When the owner relationship is optional, add `OR ($old.owner_id == null AND has_permission(<the entity's edit_permission>))`, so a caller who can see an unassigned row (Stage 7 S1) can assign it |
| F8 — Approval gate | enum transition to `approved` | `if (value_changed(workflow_state) AND workflow_state == "approved", has_permission(<the §7 derived gate>), true)` (the gate's own code under `gated` and `raci`; in `living` mode the A-gate's `or` with `is_raci_actor`, written only as an `_enforcement rules_` row; see "Gate rules") |
| F9 — Terminal lock | enum terminal state | `if (old.workflow_state in terminal_states, false (no writes), true)` |
| F10 — Self-reference guard | self-FK | `id != parent_id` (no self-loops) |
| F11 — Period boundary | `*_period` field | check inside `start_*` / `end_*` |
| F12 — Conditional permission | any field whose write should require a permission | wrap the field-change check in `require_permission` |
| F13 — Owner-row gate | a row that only its owner can edit certain fields of | nested ownership check |
| F14 — FK target state | a write that depends on the FK target being in a specific state | `set_record` lookup + state check |
| F15 — Cross-entity invariant | a rule that spans two entities | `set_record` + cross-row check |

After running all 15 families, present a scan-table to the user for confirmation. Drop the rules the user rejects.

> **Fast flow, after the go-ahead:** don't present the scan-table; accept the rules as scanned and log them in one line; don't ask ([fast-flow.md](../../semantius-admin/references/fast-flow.md)).
