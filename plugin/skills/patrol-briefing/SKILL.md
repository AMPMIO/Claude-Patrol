---
name: patrol-briefing
description: Use when briefing a Patrol seat (executor, researcher, reviewer, orchestrator) or any standing peer/subagent. Produces the six-section brief a fresh seat actually needs — context, task, why, done, do-not, escalate — with role-specific slots. Distilled from delegation-brief.
---

# Patrol Briefing

A seat starts blank and inherits nothing. Every delegation failure is a
briefing failure: the seat didn't know the constraint, the context, or what
done looked like. A brief costs ~1–2k tokens; a wrong deliverable costs the
whole seat-run plus the re-run.

## The six sections (all mandatory)

Fill every one for the specific seat. If a section feels skippable, it is
usually the one that would have prevented the failure.

1. **Context** — the 3–6 facts the seat can't discover cheaply: what project,
   what's already decided, what's already ruled out. What you'd tell a
   contractor on day one. Paste the two paragraphs that matter; don't point.
2. **Task** — one paragraph, imperative, singular. Two tasks = two seats.
3. **Why** — one sentence on what the output feeds. This lets the seat make
   the dozen micro-decisions you didn't anticipate correctly.
4. **Done looks like** — exact deliverable shape: format, length, fields,
   file paths to write, "return conclusions not raw tool output". Schema if
   you can give one.
5. **Do NOT** — the anti-scope: files not to touch, decisions not to make,
   rabbit holes not to enter. Seats over-help; fence them.
6. **Escalate if** — restated for this task: the specific ambiguity or
   above-tier trade-off that should come back rather than be guessed.

## Role slots

Fill the bracketed slots per role; keep the six sections.

- **executor** — model per routing (opus xhigh multi-step / sonnet med scoped
  / gpt-5.5 bulk). Context: [the frozen contract/interface it codes against].
  Done: [tests green + typecheck clean + commit prefix]. Escalate if: [the
  contract is internally contradictory or a decision sits above spec].
- **researcher** — sonnet sweep + higher-tier synthesis. Task: [ONE question].
  Done: [claim + evidence pairs, every unverified claim flagged; contradictions
  are findings]. Do NOT: [recommend the decision — that happens above].
- **reviewer** — fable-5 or opus. Done: [defect list, file:line + failure
  scenario + fix, ranked worst-first, zero praise]. Escalate if: [nothing is
  wrong — say so in one line, don't invent nits].
- **orchestrator** — judges and routes; does not execute. Do NOT: [do the work
  a seat should; hold context for judgment].

## Rules

- **Paste, don't point.** "See the discussion above" briefs nothing.
- **One task per seat.** Two questions get one shallow answer each.
- **Name the model + effort** for the seat, and never boot it on the default
  model (the measured $3.6–4.9/seat Fable-default leak).
- **Judge the return before building on it** — what did the seat verify vs.
  merely assert?
