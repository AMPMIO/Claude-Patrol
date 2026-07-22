#!/bin/sh
# Patrol PreToolUse deny-hook for WRITE-ENABLED codex seats (F1 defense-in-depth).
#
# BEST-EFFORT BACKSTOP, NOT A GUARANTEE. The OS sandbox (codex -s workspace-write)
# is the real security boundary; this hook is a command-level backstop on top of
# it. A blocklist over raw shell is fundamentally unwinnable — obfuscation and
# equivalent syntaxes always leak — so this closes the KNOWN destructive shapes
# and nothing more. danger-full-access removes the OS boundary entirely, leaving
# only this backstop; use it only for fully trusted work. A real allow-list model
# is v0.3 design, not this hook.
#
# Wire schema (confirmed against codex-cli 0.144.0): a hook that exits 2 with a
# reason on stderr DENIES the tool call; exit 0 ALLOWS it. This is the decision
# path — matched, not flag-spelled.
#
# The tool-call payload arrives on stdin as JSON. We match against the RAW payload
# rather than a parsed field so the hook does not depend on a specific tool-input
# schema (one fewer assumed interface — the v0.2.2 lesson). The command text
# appears verbatim in that payload, so a raw-text match is sound. Deny-biased: a
# false block costs one retry; a false allow can be irreversible.

payload=$(cat)

deny() {
  printf 'patrol-blocked: %s\n' "$1" >&2
  exit 2
}

# --- remove: blanket-deny the remove verb ---
# Flag spelling is not a reliable signal: `rm -rf`, `rm --recursive --force`,
# `rm -r --force`, `rm -fr a/../../home` are all destructive and all spelled
# differently. A write-enabled seat can already write, so a legitimate need to
# delete is rare enough to route through the human. Gate the VERB, not the flags.
# `rm` must be a command token (start-of-string, or after a shell separator/quote),
# not a substring of confirm/form/npm or a path like /usr/bin/rm.
if printf '%s' "$payload" | grep -Eq '(^|[^A-Za-z0-9_./-])rm([[:space:]]|$)'; then
  deny "file removal (rm) is blocked for automated seats"
fi

# --- git: force push (any flag/refspec form) + verify-skipping + history rewrite ---
if printf '%s' "$payload" | grep -Eq 'git[[:space:]]+push([[:space:]]|$)'; then
  # --force / -f / --force-with-lease / --no-verify, OR a '+'-prefixed refspec
  # (git's own force-update syntax, e.g. `git push origin +main:main`).
  if printf '%s' "$payload" | grep -Eq '(--force|--force-with-lease|--no-verify|[[:space:]]-f([^a-zA-Z0-9_]|$)|[[:space:]]\+[A-Za-z0-9_./@~^-]+:)'; then
    deny "git force / verify-skipping push"
  fi
fi
if printf '%s' "$payload" | grep -Eq 'git[[:space:]]+(reset[[:space:]]+--hard|rebase|filter-branch|filter-repo|update-ref[[:space:]]+-d)'; then
  deny "git history rewrite"
fi

# --- pipe-to-shell of remote content, all three shapes ---
# Forward: `curl URL | sh`.
if printf '%s' "$payload" | grep -Eq '(curl|wget|fetch)[[:space:]][^|]*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash|zsh|dash)([^a-zA-Z0-9_]|$)'; then
  deny "pipe-to-shell of remote content"
fi
# Interpreter-first: `sh -c "$(curl URL)"` — an interpreter -c with a fetch anywhere.
if printf '%s' "$payload" | grep -Eq '(sh|bash|zsh|dash|ksh)[[:space:]]+-c([[:space:]]|$|")' \
   && printf '%s' "$payload" | grep -Eq '(curl|wget|fetch)([[:space:]]|$)'; then
  deny "shell -c executing fetched content"
fi
# Process substitution: `bash <(curl URL)`.
if printf '%s' "$payload" | grep -Eq '<\([^)]*(curl|wget|fetch)'; then
  deny "process substitution of remote content"
fi

# No destructive pattern matched: allow.
exit 0
