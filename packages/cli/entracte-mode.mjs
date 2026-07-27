#!/usr/bin/env node
/**
 * entracte content-mode helper — switch what shows on your surfaces:
 * sponsors (ads, you earn), motivation quotes, or dev news. Installed by
 * `npx entracte` to ~/.claude/entracte-mode.mjs and called by the /entracte
 * slash command (never via npx — npx is install-only). Reads the linked machine
 * token and PATCHes the publisher. No deps. PolyForm-Noncommercial-1.0.0.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = (process.env.ENTRACTE_API || "https://api.entracte.ai").replace(
	/\/$/,
	"",
);
const CREDS = join(
	process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
	"entracte",
	"credentials.json",
);
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const LABELS = {
	ads: "sponsors (you earn AI credits)",
	quotes: "motivation quotes (no ads, no earnings)",
	news: "dev news from Hacker News (no ads, no earnings)",
};

const mode = process.argv[2];
if (!LABELS[mode]) {
	console.log("Usage: /entracte <ads | quotes | news>");
	process.exit(mode ? 1 : 0);
}

let token;
try {
	token = JSON.parse(readFileSync(CREDS, "utf8")).token;
} catch {
	/* not linked */
}
if (!token) {
	console.error(
		"✗ This machine isn't linked to your entracte account yet.\n  Run `npx entracte login`, then retry.",
	);
	process.exit(1);
}

try {
	const res = await fetch(`${API}/api/publisher`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ contentMode: mode }),
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
	console.error(`✗ Couldn't switch mode (${err.message}). Try again shortly.`);
	process.exit(1);
}

console.log(
	green(`✓ Now showing ${LABELS[mode]}.`) +
		dim(" Status line updates within ~10s; the spinner on your next session."),
);
