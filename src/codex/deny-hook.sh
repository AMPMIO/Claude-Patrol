#!/bin/sh
# Patrol PreToolUse deny-hook for WRITE-ENABLED codex seats (F1 defense-in-depth).
#
# A codex seat driven by messages from other seats is an untrusted execution
# path. Codex's own -s workspace-write sandbox already confines writes to the
# --cd root; this hook is the command-level layer on top of it, blocking
# destructive shell commands the OS sandbox would still permit INSIDE the
# workspace (history rewrites, force pushes, pipe-to-shell). It is intentionally
# deny-biased: a false block costs one retry, a false allow can be irreversible.
#
# Contract (verified against codex-cli 0.144.0 --dangerously-bypass-hook-trust):
# emitting a permissionDecision=deny object on stdout blocks the tool call. The
# equivalent alternate form is exit 2 with a stderr reason; we use the stdout
# form. No output + exit 0 = allow.
#
# The tool-call payload arrives on stdin as JSON. We match against the RAW
# payload rather than a parsed field so the hook does not depend on a specific
# tool-input schema (one fewer assumed interface — the v0.2.2 lesson). The
# command text appears verbatim in that payload, so a raw-text match is sound.

payload=$(cat)

deny() {
  # Escape nothing fancy: reasons are fixed literals with no JSON metacharacters.
  printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"patrol-blocked: $1\"}}"
  exit 0
}

# Recursive force-remove of an absolute or home-rooted path, or of a parent dir.
if printf '%s' "$payload" | grep -Eq 'rm[[:space:]]+(-[a-zA-Z]*[rf][a-zA-Z]*[[:space:]]+)+(-[a-zA-Z]+[[:space:]]+)*(/|~|\.\.)'; then
  deny "recursive force remove of an absolute/home/parent path"
fi
# git force push (--force, -f, --force-with-lease, in any argument order). Two
# stages so a bare trailing `-f` matches regardless of what precedes it — POSIX
# ERE is leftmost-longest without backtracking, so a single greedy pattern drops
# the `git push … -f` case. The end anchor allows a non-word char (a quote from
# the surrounding JSON) as well as whitespace/EOL.
if printf '%s' "$payload" | grep -Eq 'git[[:space:]]+push([[:space:]]|$)' \
  && printf '%s' "$payload" | grep -Eq '(--force|--force-with-lease|[[:space:]]-f([^a-zA-Z0-9_]|$))'; then
  deny "git force push"
fi
# git history rewrites.
if printf '%s' "$payload" | grep -Eq 'git[[:space:]]+(reset[[:space:]]+--hard|rebase|filter-branch|filter-repo|update-ref[[:space:]]+-d)'; then
  deny "git history rewrite"
fi
# curl|sh / wget|sh — running remote content as a shell script. The interpreter
# may be followed by a JSON quote, so anchor on a non-word char, not just space.
if printf '%s' "$payload" | grep -Eq '(curl|wget)[[:space:]][^|]*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash|zsh|dash)([^a-zA-Z0-9_]|$)'; then
  deny "pipe-to-shell of remote content"
fi

# No destructive pattern matched: allow.
exit 0
