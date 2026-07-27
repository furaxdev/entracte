#!/usr/bin/env node
/**
 * `npx entracte` — install the entracte sponsor surfaces into Claude Code:
 *   1. a cookieless status-line sponsor (~/.claude/entracte-statusline.mjs) — the default
 *   2. (opt-in, --spinner) a sponsored spinner verb woven into "thinking"
 *      (~/.claude/entracte-spinner.mjs, refreshed per turn via SessionStart +
 *      UserPromptSubmit + Stop hooks) that shares its sponsor with the status
 *      line. It REPLACES Claude's own thinking verb, so it stays off by default.
 *
 * Writes to ~/.claude/settings.json (with a backup). `--uninstall` reverses
 * everything; the default installs only the status line, `--spinner` also
 * sponsors the thinking verb. PolyForm-Noncommercial-1.0.0.
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = homedir();
const CLAUDE = join(HOME, ".claude");
const SETTINGS = join(CLAUDE, "settings.json");
const HERE = dirname(fileURLToPath(import.meta.url));

const DEST_SL = join(CLAUDE, "entracte-statusline.mjs");
const SRC_SL = join(HERE, "..", "statusline.mjs");
const DEST_SPIN = join(CLAUDE, "entracte-spinner.mjs");
const SRC_SPIN = join(HERE, "..", "spinner.mjs");
const CMD_DIR = join(CLAUDE, "commands");
const DEST_CMD = join(CMD_DIR, "entracte.md");
const DEST_MODE = join(CLAUDE, "entracte-mode.mjs");
const SRC_MODE = join(HERE, "..", "entracte-mode.mjs");

// ── subcommands ──────────────────────────────────────────────────────────
// A subcommand runs INSTEAD of the installer. Flags keep working unchanged: a
// bare `npx entracte` (or `--spinner`/`--uninstall`) has no bare argv[2].
if (process.argv[2] === "login") {
	await import(pathToFileURL(join(HERE, "..", "login.mjs")).href);
	process.exit(0);
}

// Claude Code custom slash command → `/entracte <ads|quotes|news>`. It calls the
// INSTALLED helper (not npx — npx is install-only), so the switch is instant.
const ENTRACTE_COMMAND_MD = `---
description: entracte — show a sponsor, motivation quotes, or dev news on your surfaces
argument-hint: [ads | quotes | news]
allowed-tools: Bash(~/.claude/entracte-mode.mjs:*)
---
Switch the entracte content mode, then confirm the result to the user in one short line.

!\`~/.claude/entracte-mode.mjs $ARGUMENTS\`
`;

const MARK = "✦"; // tags entracte-managed spinner verbs

const uninstall = process.argv.includes("--uninstall");
// The spinner verb REPLACES Claude's own "thinking" word, so it's opt-in
// (--spinner). By default entracte installs only the unobtrusive status line.
// (--no-spinner is still accepted — it's now the default, so it's a no-op.)
const withSpinner = process.argv.includes("--spinner");
// With --spinner: the sponsor REPLACES the thinking word. --mixed keeps Claude's
// own verbs too (append mode, sponsor ~appears a fraction of the time).
const mixed = process.argv.includes("--mixed");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function loadSettings() {
	if (!existsSync(SETTINGS)) return {};
	try {
		return JSON.parse(readFileSync(SETTINGS, "utf8"));
	} catch {
		console.error(
			"✗ ~/.claude/settings.json is not valid JSON — fix it first, then re-run.",
		);
		process.exit(1);
	}
}

function backup() {
	if (existsSync(SETTINGS)) {
		writeFileSync(`${SETTINGS}.entracte-bak`, readFileSync(SETTINGS));
	}
}

function save(settings) {
	writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

/** True if a hook group runs the entracte spinner hook. */
function groupIsOurs(group) {
	return (
		Array.isArray(group?.hooks) &&
		group.hooks.some((h) =>
			String(h?.command || "").includes("entracte-spinner"),
		)
	);
}

/**
 * Register (idempotently) the hooks that refresh the sponsor. SessionStart seeds
 * it; UserPromptSubmit + Stop refresh it once per turn so it rotates live.
 */
function ensureSpinnerHook(settings) {
	settings.hooks = settings.hooks || {};
	const cmd = `~/.claude/entracte-spinner.mjs`;
	const group = () => ({
		hooks: [{ type: "command", command: cmd, timeout: 10 }],
	});
	const clean = (ev) =>
		(Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : []).filter(
			(g) => !groupIsOurs(g),
		);

	// SessionStart requires an explicit matcher per group.
	const ss = clean("SessionStart");
	for (const matcher of ["startup", "resume"]) ss.push({ matcher, ...group() });
	settings.hooks.SessionStart = ss;

	// UserPromptSubmit + Stop fire once per turn; no matcher.
	for (const ev of ["UserPromptSubmit", "Stop"]) {
		const arr = clean(ev);
		arr.push(group());
		settings.hooks[ev] = arr;
	}
}

/** Remove the entracte spinner hooks (any event) + our spinnerVerbs block. */
function removeSpinner(settings) {
	if (settings.hooks && typeof settings.hooks === "object") {
		for (const ev of Object.keys(settings.hooks)) {
			if (!Array.isArray(settings.hooks[ev])) continue;
			settings.hooks[ev] = settings.hooks[ev].filter((g) => !groupIsOurs(g));
			if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
		}
		if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
	}
	const sv = settings.spinnerVerbs;
	if (
		sv &&
		Array.isArray(sv.verbs) &&
		sv.verbs.every((v) => String(v).includes(MARK))
	) {
		delete settings.spinnerVerbs;
	}
}

/** Fetch the sponsor pool now so session #1 already has spinner verbs. */
async function initialVerbs() {
	try {
		const { fetchPool } = await import(pathToFileURL(SRC_SPIN).href);
		const { verbs } = await fetchPool({});
		return verbs.length ? verbs : null;
	} catch {
		return null;
	}
}

if (!existsSync(CLAUDE)) mkdirSync(CLAUDE, { recursive: true });

// ── uninstall ────────────────────────────────────────────────────────────
if (uninstall) {
	const settings = loadSettings();
	backup();
	let touched = false;

	if (
		String(settings.statusLine?.command || "").includes("entracte-statusline")
	) {
		delete settings.statusLine;
		touched = true;
	}
	const hadSpinner = !!(
		(settings.hooks &&
			Object.values(settings.hooks).some(
				(arr) => Array.isArray(arr) && arr.some(groupIsOurs),
			)) ||
		settings.spinnerVerbs ||
		existsSync(DEST_SPIN)
	);
	removeSpinner(settings);
	if (hadSpinner) touched = true;
	save(settings);

	for (const f of [DEST_SL, DEST_SPIN, DEST_CMD, DEST_MODE]) {
		if (existsSync(f)) {
			try {
				unlinkSync(f);
			} catch {
				/* ignore */
			}
		}
	}
	console.log(
		green(
			touched
				? "✓ entracte removed (status line + spinner)."
				: "Nothing to remove.",
		),
	);
	process.exit(0);
}

// ── install ──────────────────────────────────────────────────────────────
console.log(bold("entracte — installing the cookieless sponsor surfaces\n"));
const settings = loadSettings();
backup();

// 1. status line
copyFileSync(SRC_SL, DEST_SL);
// Claude Code runs the statusLine command by its bare path, so it must be
// executable — without this the shell returns "permission denied" and the
// status line silently stays empty.
chmodSync(DEST_SL, 0o755);
const previousStatus = settings.statusLine;
settings.statusLine = {
	type: "command",
	command: "~/.claude/entracte-statusline.mjs",
	refreshInterval: 10,
};
console.log(green(`✓ status line → ${DEST_SL}`));

// 2. sponsored spinner — OPT-IN (--spinner). It replaces Claude's own thinking
//    verb, so by default we skip it and clean up any spinner a prior version
//    installed, restoring Claude's own verbs.
if (withSpinner) {
	copyFileSync(SRC_SPIN, DEST_SPIN);
	chmodSync(DEST_SPIN, 0o755);
	ensureSpinnerHook(settings);
	const verbs = await initialVerbs();
	if (verbs?.length)
		settings.spinnerVerbs = { mode: mixed ? "append" : "replace", verbs };
	console.log(green(`✓ sponsored spinner → per-turn hooks (rotates live)`));
	if (!verbs) {
		console.log(
			dim("  (couldn't reach the network — the hook fills it next session)"),
		);
	}
} else {
	// Default path: no spinner. Remove any spinner hooks/verbs a previous
	// install left behind so re-running `npx entracte` gives Claude's own
	// thinking words back — and drop the now-unused helper file.
	removeSpinner(settings);
	if (existsSync(DEST_SPIN)) {
		try {
			unlinkSync(DEST_SPIN);
		} catch {
			/* ignore */
		}
	}
	console.log(
		dim(
			"  (status line only — add --spinner to also sponsor the thinking verb)",
		),
	);
}

// 3. Claude Code slash command + the mode helper it calls (never via npx)
copyFileSync(SRC_MODE, DEST_MODE);
chmodSync(DEST_MODE, 0o755);
if (!existsSync(CMD_DIR)) mkdirSync(CMD_DIR, { recursive: true });
writeFileSync(DEST_CMD, ENTRACTE_COMMAND_MD);
console.log(green("✓ /entracte slash command"));

save(settings);
console.log(green(`✓ ~/.claude/settings.json configured`));
if (existsSync(`${SETTINGS}.entracte-bak`)) {
	console.log(dim(`  (backup: ${SETTINGS}.entracte-bak)`));
}
if (
	previousStatus &&
	!String(previousStatus.command || "").includes("entracte")
) {
	console.log(
		dim(
			"  ℹ your previous statusLine was replaced — restore it from the backup if needed.",
		),
	);
}
console.log(
	`\n→ ${bold("Restart Claude Code")}. Status line: ⬦ <sponsor> ${dim("· Sponsored")}`,
);
if (withSpinner) {
	console.log(
		dim(
			`  While it thinks, the word becomes a ${MARK} sponsor${mixed ? " (mixed with Claude's)" : " (--mixed to blend instead)"}.`,
		),
	);
}
console.log(
	dim("  Switch content:     /entracte <ads|quotes|news>  (in Claude Code)"),
);
console.log(dim("  Uninstall anytime:  npx entracte --uninstall\n"));
