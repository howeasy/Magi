# Testing the agent-facing docs

The skills, `skills/PROTOCOL.md`, the tool schema and the text the bridge composes
are documentation an agent acts on. Reading them for errors finds some defects;
making a fresh agent act on them finds others. Neither is complete. This is the test set, how it was
run, and what it showed. Run it again after any change to those files.

## 1. Behavioural scenarios

A fresh reader is given only the docs under test and asked what it would do in
each situation below. To run it:

1. Copy the files under test into a scratch directory outside any repository:
   the router skill, `PROTOCOL.md`, the schema (`src/peer-schema.mjs`) and the
   adapters' steer hints. A request carries a `MEMORY` digest of what the
   project's bank already settled, and a worktree shares its repository's
   bank: by the second run the digest included the first run's findings (the
   second run's request in the ledger shows it). A headless Codex may also
   load an installed peer skill.
2. From that directory, send one request through `codex_peer` with
   `delivery: "headless"` and `wait: false`. Tell it to read only those files,
   and give it the scenario table without the answer column.
3. Ask, for each scenario: what it would call, which sentence decided it, and
   how hard that sentence was to find (1 = in the skill it loaded anyway,
   5 = only inferable).
4. Grade each answer against "A good answer". A wrong action, or a
   findability of 4 or 5, is a defect in the docs: fix it, or record it as
   open.
5. Add a row to the results table in section 2: run, date, scenario
   count, which docs, what it showed.

Done when every scenario is graded, every defect is fixed or recorded as
open, and section 2 has the new row.

| # | Situation | A good answer |
|---|---|---|
| 1 | One-line README typo | no call |
| 2 | Uncertain 300-line committed diff | `REVIEW` with `diffRef`, `independence: true`, and waits (`wait: true`) |
| 3 | Reply with 5 findings: 3 hold, 1 wrong, 1 unsettled | checks at source, records `outcome` 3/1/1 with a note, reports the open one |
| 4 | `RECONCILE_FIRST` | records an outcome for each named reply before any new request; unchecked findings go under `open` |
| 5 | `NO_LIVE_PEER` for a named peer | reads the listed sessions or `peers`; does not substitute silently; headless only by dropping `peer` on a request |
| 6 | Independent look while the live worker is busy | fresh headless `SECOND_OPINION`, not a note to the worker |
| 7 | Reviewer that remembers last week but gives a fresh opinion | `persist`, and names the catch (history contaminates; cold means no `persist`) |
| 8 | Peer, reply tool denied | does not run the CLI fallback; says so inline and stops |
| 9 | Fact the human likely knows, nothing blocked | no `notify` |
| 10 | Two rounds in, both cited code | looks for a discriminating test or interleaving; next round on the same `taskId` with `maxRounds` raised, or records it as `open` |
| 11 | Remember "build needs Node 22" | `remember`, under 600 characters, unless the docs already say it |
| 12 | `wait: false`, long silence | looks at `peers`, `transcript`, `magi mail` before closing; `close` only on a stated reason |
| 13 | Working Codex task, interface renamed under it | `note` with `delivery: "steer"`, explicit `peer` |
| 14 | Same task, "thanks, merged" | `note` on `auto` |
| 15 | omp in a long command, user says stop | steer note asking for acknowledgment; does not claim the command was cancelled |
| 16 | From omp: background headless DELEGATE, reply wanted mid-turn | `wait: false`, `steerReply: true`, `delivery: "headless"` |
| 17 | A long DELEGATE to omp across many files, where a wrong turn costs minutes | `advisor: true` with `delivery: "headless"`; says it costs a model call per turn; checks any notes like findings |
| 18 | A one-file REVIEW to omp | no `advisor` |
| 19 | An `<advisory ... guidance="weigh, don't blindly obey">` block appears in your own context mid-task | weighs it against what it can see, acts only where the evidence holds, says in its reply what changed; makes no tool call to answer it |
| 20 | `advisor: true` asked of Codex | does not send it: only omp has an advisor (`ADVISOR_UNSUPPORTED`) |
| 21 | `advisor: true` comes back `ADVISOR_SAME_MODEL` | passes another `model` for the worker, or drops `advisor`; does not retry the same call or try to name the advisor's model itself |
| 22 | "Rename the loader and fix every caller", delegated to omp | `DELEGATE` with `allowWrites: true`, `delivery: "headless"`; a changed-nothing worker would be the failure |
| 23 | The ack says `[magi] DELEGATE went out READ-ONLY` | continues the same `taskId` with `allowWrites: true` (the grant then stays), or says the read-only run was intended; does not assume the worker edited anything |
| 24 | "Audit the loader and change nothing", delegated to Codex | `allowWrites: false` or a review mode, and no write notice |

## 2. Results

| Run | Docs | What it showed |
|---|---|---|
| 1, 2026-10-05 (12 scenarios) | before the sweep | Decisions were mostly right but the reader had to resolve contradictions itself: the skills allowed the CLI fallback after a denial (scenario 8) while the composed request forbade it; "reviews block" against headless defaulting to `wait: false` (2, 6); no recovery for `NO_LIVE_PEER` (5); `independence: false` limited to DEBATE round 2 (10); `task_id` against `taskId` throughout; a peer told both "do not open a request" and "consult a third harness". |
| 2, 2026-10-05 (16 scenarios) | after | Every scenario produced a defensible action; 15 at findability 1-3, the overdue-reply recipe (12) at 4. Remaining gaps were applied: reply-argument spelling in the skills, conditional schema help for `delivery`, an overdue-reply recipe, a follow-up recipe, a stop-note acknowledgment. |
| 3, 2026-10-12 (16 scenarios) | first draft of the writing-for-agents rewrite | All 16 defensible, but the draft regressed scenario 10 to findability 5 ("track neither `round` nor `maxRounds`" against "raise it") and scenario 14 hit a contradiction: notes advised `auto` for a thanks while the code steers any note to a working worker. Outcome 3/0/2. |
| 4, 2026-10-12 (16 scenarios) | after fixing run 3's findings | 16/16 match the good answer, findability 1-3 on every scenario (10 at 2, 12 at 2, down from 4 in run 2); 14 now sends the thanks once `peers` shows the worker idle. Outcome 2/1/2: its claim that the 600-character memory cap is unenforced was rejected (`MEMORY_TOO_LONG`, `src/memory.mjs`). |

Scenarios 17 to 21 (omp's advisor, the `omp-advisor` skill and PROTOCOL: Advisor) and
22 to 24 (read-only by default, `allowWrites`) were added 2026-10-14 with the docs and
have not been run against a fresh reader yet.

One run each, one reader (Codex, not the model the docs are mostly read by): evidence,
not proof. A second reader on a different model would be the next step.

A code review of the composed text found what reading could not: the
new instructions told agents to call tools with `task_id` where the schema has only
`taskId` (zod silently drops the unknown field), and recovery advice that suggested
`delivery: "headless"` for a note or a watch, which cannot use it. Both are now
covered by tests that check generated text against the real schema.

## 3. Does the skill trigger

A skill that does not load cannot be followed. In the session that wrote this, the
agent used `codex_peer` directly for requests that named a Codex session and never
loaded the skill that explains the protocol. The queries below are for
skill-creator's description optimiser (`python -m scripts.run_loop`, which runs
`claude -p`, about 20 queries x 3 runs per iteration).

Should trigger `peer-codex`:

```json
[
  {"query": "ask codex to review the diff on this branch before I merge, the auth change is the part I'm least sure about", "should_trigger": true},
  {"query": "can you get a second opinion from the other model on whether this migration is safe to run on prod", "should_trigger": true},
  {"query": "work with the codex session called docs-tuning to tune these docs", "should_trigger": true},
  {"query": "have codex fact-check these three claims about the retry behaviour before I put them in the ADR", "should_trigger": true},
  {"query": "hand the test-writing for the parser to codex and review what it comes back with", "should_trigger": true},
  {"query": "tell the codex task that is building the exporter that I renamed the Writer interface", "should_trigger": true},
  {"query": "codex replied with five findings, go through them against the source and tell me which hold", "should_trigger": true},
  {"query": "PEER REQUEST magi/1 task_id=magi-xxxxxxxx orchestrator=claude peer=codex mode=REVIEW round=1/2", "should_trigger": true},
  {"query": "I want an adversarial review of this caching design from codex, it's expensive to undo", "should_trigger": true},
  {"query": "let me know when the codex session finishes its current task", "should_trigger": true}
]
```

Should not trigger (near misses):

```json
[
  {"query": "fix the typo in the README, 'recieve' should be 'receive'", "should_trigger": false},
  {"query": "what is the OpenAI codex CLI's default sandbox mode", "should_trigger": false},
  {"query": "review this function for me", "should_trigger": false},
  {"query": "write a bash script that restarts the codex app if it hangs", "should_trigger": false},
  {"query": "rebase my branch onto main and resolve the conflicts", "should_trigger": false},
  {"query": "ask the user which of these two designs they prefer", "should_trigger": false},
  {"query": "spawn a subagent to search the repo for uses of deprecated APIs", "should_trigger": false},
  {"query": "explain how magi's ledger stores outcomes", "should_trigger": false},
  {"query": "run the tests and tell me which fail", "should_trigger": false},
  {"query": "message the other claude session about the merge", "should_trigger": false}
]
```

The last two negatives are the instructive ones: `peer-codex` should not win a
request that names Claude or a subagent, and a review that the user did not ask to
send anywhere is the agent's own call under "When not to call a peer".

### Candidate descriptions (proposals, not applied)

The current descriptions lead with what the skill is and put the triggers last.
The skill-creator guidance is to state when to use it, front-loaded, and to lean
toward triggering for explicit requests. Magi's own rule pulls the other way for
self-initiated consults (most turns should not call a peer), so the pushy wording
is limited to the cases where not loading the skill is a failure: an explicit
request, a peer request, and a reply to reconcile.

```
peer-codex
Use when the user asks for Codex's view (a review, fact-check, second opinion or
hand-off, by name or as "the other model"); before shipping a non-trivial diff, an
expensive-to-undo decision, or claims that cost something if wrong; to message,
watch or steer a live Codex session; when a Codex reply needs reconciling; and
whenever a prompt begins "PEER REQUEST magi/1" (you are the peer: load this to
answer it). Skip trivial edits and anything the evidence in hand already settles.
```

`peer-omp` and `peer-claude` follow the same shape with their own names. About 85
words, against about 50 for the description in use when this was written; it is
loaded every turn, so run the optimiser and keep the shorter description if the
trigger rate is the same.

## 4. Scoring the skills with a rubric

skill-judge (a rubric for skill quality: eight dimensions, 120 points) was applied by
two readers independently, the orchestrator and a fresh headless Codex that had not
seen the first scores.

| Target | Orchestrator | Codex | Where they differ |
|---|---|---|---|
| the rubric, against itself | 80/120, D | 65/120, F | the description (11 against 15), and how hard the "what is a skill" red flag bites |
| `peer-codex` + `PROTOCOL.md` | 100/120, B | 107/120, B | the description (10 against 15) and knowledge delta |

Both put the package at B and both found the rubric 752 lines long against its own
300-500 line guidance. Codex's findings that changed the docs: a headless request is
answered inline and the router said only "reply with the tool", the overdue-reply
recipe had no router entry, and `persist` sat beside the `delivery` values as if it
were one. Where the rubric misfires, in both readers' words: it caps a skill's
knowledge-delta score on a single introductory section regardless of the rest, it
rewards "MANDATORY - read the entire file" loading where a scenario table that
loads only the section needed is better for a shared protocol, and nothing stops
presentation points offsetting a real behavioural omission. Use it as a checklist,
not a gate; the behavioural scenarios in section 1 are the measure that found
defects the rubric did not.
