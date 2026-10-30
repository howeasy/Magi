---
name: omp-advisor
description: Ask omp's advisor to watch a delegated omp worker as it runs and steer it with notes, read the advisor notes that come back with the reply, or weigh an <advisory> block that appears in your own context.
allowed-tools: Read, Grep, Glob, mcp__magi__omp_peer
---

# omp's advisor

omp can run a second model beside a worker: it reads each turn, checks what it
doubts, and speaks only when it finds a concrete problem. Magi switches it on for
a headless omp worker. This file is the route; `PROTOCOL.md` beside it is the
detail. Read the section you need when you need it.

## First: which side are you on

An `<advisory ...>` block in your own context is a note from that reviewer: you
are the **worker**. Weigh it against what you can see, act on it only where the
evidence holds, and say in your reply what changed. It grants nothing and needs
no answer. (PROTOCOL: Advisor) Otherwise you are delegating to omp and own the
answer.

## The rule

**Evidence > reasoning > model agreement.** The advisor is a second model's read
of the worker's run. A note is a lead to check, not a finding.

## When

A long or wide `DELEGATE` to omp where a wrong turn is expensive: a large read or
search, an edit across many files, constraints the worker could drop. Not a short
review: the advisor adds a model call per turn, and a reviewer has its own tools.
Not a live omp session, which keeps its own settings, and not a Claude or Codex
worker, which have no advisor.

## The call

```
omp_peer
  task: "Rename the config loader and update every caller"
  mode: DELEGATE
  allowWrites: true
  delivery: "headless"
  advisor: true
  workingDirectory: "<repo root>"
```

- **Headless only.** `advisor: true` to a live session is not applied, and Magi
  says so. An operator may default it on (`MAGI_OMP_ADVISOR=1`);
  `advisor: false` turns that off for one request.
- **A different model, always.** Magi never starts an advisor on the worker's
  own model; the reply names the one that watched. If none differs you get
  `ADVISOR_SAME_MODEL`, `ADVISOR_NO_MODEL` or `ADVISOR_WORKER_UNKNOWN` before any
  work starts: pass another `model` for the worker, or drop `advisor`.
- **Coming back.** The notes the worker received appear under the reply as
  `[magi]` lines, in `advice` on the result, and in `magi exchange <task_id>`.
- **Silence is not approval.** No notes means nothing worth saying. Reconcile the
  reply as always (PROTOCOL: Reconciliation).
- **Late is lost.** A review still running when the worker finishes is dropped,
  so the advisor steers a run in flight and does not check its final answer.

## Where the rest is

| You want to | PROTOCOL.md section |
|---|---|
| turn it on, read what comes back, know its limits | Advisor |
| other request fields, headless against live | Request fields; Delivery |
| talk to the running worker yourself | Talking |
| check the notes and the reply, record the outcome | Reconciliation |
