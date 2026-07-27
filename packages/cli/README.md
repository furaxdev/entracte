# entracte

Earn **AI credits** on **Claude Code** in one command — a discreet, clearly
labelled sponsor line, and every impression on your surfaces credits you. The
*clean, official* way (uses only supported settings, patches nothing):

1. a **status line** sponsor (the default), and
2. *(opt-in, `--spinner`)* a **sponsored spinner verb** woven into the
   "thinking" word — it replaces Claude's own verb, so it stays off by default.

## Install

```bash
npx entracte
```

That writes `~/.claude/entracte-statusline.mjs` + `~/.claude/entracte-spinner.mjs`
and configures `~/.claude/settings.json` (with a backup). Restart Claude Code:

```
# status line (the default)
⬦ Reach European developers, privacy-first · Sponsored

# with --spinner, the "thinking" word also becomes the sponsor
✦ Become a sponsor…
```

Cmd/Ctrl-click the status line to open the sponsor (iTerm2 / Kitty / WezTerm).
Also sponsor the thinking verb: `npx entracte --spinner` (add `--mixed` to blend
it with Claude's own verbs instead of replacing them). Uninstall anytime:

```bash
npx entracte --uninstall
```

## Earn

Link this machine to your entracte account to earn AI credits from the sponsors
shown on your surfaces. It prints a code, opens `entracte.ai/link`, and saves the
machine token to `~/.config/entracte/credentials.json` once you confirm:

```bash
npx entracte login
```

## What it does (and doesn't)

- Calls the same surface-agnostic `/api/serve` as the web widget.
- **Status line:** caches the decision (30s); fires the view beacon **only when
  the session is active** — advertisers pay for real attention, not idle tabs.
- **Status line refreshes per turn — and with `--spinner`, shares its sponsor
  with the thinking verb.** Hooks (`SessionStart` + `UserPromptSubmit` + `Stop`)
  fetch a fresh sponsor each turn and publish it to a session cache the status
  line reads; with `--spinner` they also set `spinnerVerbs` (the "thinking"
  word — `replace` by default, `--mixed` to blend with Claude's own). So the
  bottom line rotates every turn, and the spinner mirrors it when enabled.
  Claude Code hot-reloads `settings.json`, so the live spinner update depends on
  the build honoring that for `spinnerVerbs`; the status line is dynamic either
  way. Only the status line fires the (metered) view beacon — once per sponsor.
  The hook returns instantly and prints nothing (a detached worker does the
  fetch), so it never delays startup or leaks into the conversation.
- Sets **no cookies**, sends **no identifiers**, reads **no code** — only the
  repo's shape (language/framework) for context.
- If you've linked your machine (`entracte` earner account), impressions are
  attributed to you and you earn AI credits — spendable on any model.
- Patches nothing of Anthropic's. Removing it leaves zero trace.

Env (optional): `ENTRACTE_API` (default `https://api.entracte.ai`),
`ENTRACTE_PUBLISHER` (default `entracte`).

A pure-Python status-line variant (`entracte-statusline.py`) ships too.
