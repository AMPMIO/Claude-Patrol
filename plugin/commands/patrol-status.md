---
description: Show the Patrol fleet board — seats, roles, models, per-seat spend
allowed-tools: Bash(patrol status)
---

Run the fleet board and present it to the user:

!`patrol status`

Then, in one or two lines: name the highest-spend seat, and flag any seat that is stale (long since last seen) or idle. If the command errored (broker down), tell the user to run `patrol doctor`.
