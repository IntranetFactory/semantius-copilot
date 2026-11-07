# use-semantius CHANGELOG

This file is history, not contract: it is **not** loaded into context at runtime. The body of `SKILL.md` is always the current contract. Newest entries first.

## One creation order, stated once

2026-11-07. Asked for by Martin Amm: `data-modeling.md` "Mandatory Creation Order" is the single source for the creation order. Golden Rule 2 in `SKILL.md` and Agent Workflow Tip 2 now point to it instead of restating it, so the module-wiring step (`update_module`) is never dropped. The classify-without-asking, state-the-result and read-back clause moved into the section's entity step. The two "DUPLICATE … Edit both" markers became "Family variant" notes naming `entity-families.md` "Creating a family" as the section that governs families. `rbac.md` cites the wiring step by title, not by number. The section now covers the whole module setup (permissions, `update_module` wiring, permission hierarchy, roles, role grants, default-role wiring, entities, fields), so `crud-tools.md` "Order for a new module" is a pointer to it and `rbac.md` no longer restates the wiring position.

## Every enum entry gets an icon that fits

2026-11-07. Asked for by Martin Amm: in `data-modeling.md` "Enum values and labels", every entry of every enum gets an icon that fits its meaning; there is no distinction between state and other enums. A new "Enum icons" table maps entry meanings to Lucide icons, `lucide-icon-finder.ts` covers labels the table does not (an entry the finder finds nothing for has no icon), and one `lucide-icon-checker.ts` call checks all of a module's enums. The `contract_type` example gives every entry an icon. The file format is unchanged; `version` stays `3.1`.

## Find the built-in tool before building

2026-11-06. Asked for by Martin Amm: `SKILL.md` gains a Quick Decision Guide entry and the section "Find the built-in tool before building". Before building a script, diagram, document, report or export from the model, the agent searches the CLI for a tool that already produces it (`search_tools` over names and descriptions, `tools <server> <tool>` for the signature). The rule names no tool, so generators added to the CLI later are found the same way. The file format is unchanged; `version` stays `3.1`.

## Entity classification and write permissions live here

2026-11-06. Asked for by Martin Amm: `use-semantius` owns the whole concept of classifying an entity and of giving it the right permissions, so an entity built without the architect, analyst or modeler is classified and permissioned correctly. `data-modeling.md` gains "Classifying an entity" (the six classes, the derivation ladder, the class-to-write-tier table, junction rules, reclassification, the read-back check); `rbac.md` gains "Choosing an entity's permissions" (write tier to `view_permission` and `edit_permission`, for hand-built and spec-deployed modules) and its setup steps create `<slug>:admin`, an admin role and `access_scope: advanced`. Every `create_entity` example and the creation-order steps carry `entity_type`, `view_permission` and `edit_permission`. The pipeline skills reference these sections. The class is chosen without a question and named in the summary. `rbac.md` also gains "Restricted steps (gates)": a module with a restricted step is `gated` (or stays `raci`), each gate is a `<slug>:<verb>_<noun>` permission included by `<slug>:admin`, and a validation rule checks it with `has_permission`. The file format is unchanged; `version` stays `3.1`.
