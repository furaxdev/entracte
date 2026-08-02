#!/usr/bin/env node
/**
 * entracte spinner refresh — keeps ONE cookieless "current sponsor" fresh and
 * shared between two Claude Code surfaces:
 *   1. `spinnerVerbs` in ~/.claude/settings.json — the word shown while thinking.
 *   2. a session-scoped cache (`entracte-cur-<sid>.json`) that the status line
 *      reads, so the bottom line shows the SAME sponsor (clickable + metered).
 *
 * Runs as a per-turn hook (SessionStart + UserPromptSubmit + Stop). Claude Code
 * hot-reloads settings.json mid-session, so rewriting `spinnerVerbs` each turn
 * rotates the spinner live (if the build honors it for this key; the status line
 * is dynamic regardless). The hook returns instantly and prints NOTHING (its
 * stdout would land in Claude's context) — a detached worker does the network +
 * writes. No deps, no python. PolyForm-Noncommercial-1.0.0.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Anonymous per-machine install id, INLINED (no import) so this file stays
// standalone when copied to ~/.claude/. First-party only; best-effort.
function installId() {
	try {
		const dir = join(
			process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
			"entracte",
		);
		const file = join(dir, "install-id");
		if (existsSync(file)) {
			const v = readFileSync(file, "utf8").trim();
			if (v) return v;
		}
		mkdirSync(dir, { recursive: true });
		const id = randomUUID();
		writeFileSync(file, id, { mode: 0o600 });
		return id;
	} catch {
		return null;
	}
}

const API = (process.env.ENTRACTE_API || "https://api.entracte.ai").replace(
	/\/$/,
	"",
);
// Resolved lazily: CREDS is defined below, and a linked machine should serve
// for ITS OWN publisher — otherwise every impression is credited to the house
// account and linking earns the developer nothing.
const publisher = () =>
	process.env.ENTRACTE_PUBLISHER || machinePublisher() || "entracte";
const HOME = homedir();
const SETTINGS = join(HOME, ".claude", "settings.json");
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(HOME, ".config");
const CREDS = join(CONFIG_HOME, "entracte", "credentials.json");
const TMP = process.env.TMPDIR || "/tmp";
const TTL_MS = 20_000; // refresh the sponsor at most this often (per-turn hooks fire more)

/** Marks a verb as entracte-managed, so uninstall can remove only ours. */
export const MARK = "✦"; // ✦

/**
 * Finding H4 (defense-in-depth): the server strips control chars, but a
 * compromised or OLDER server could still ship terminal escape / control
 * characters in sponsor copy. Strip them from ANY advertiser text before it
 * reaches stdout (the status-line pool cache) or ~/.claude/settings.json
 * (spinnerVerbs). Keeps normal printable text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping untrusted terminal control/escape chars
const CTRL = /[\x00-\x1F\x7F]/g;
const clean = (s) => String(s ?? "").replace(CTRL, "");
/** Finding H4: only ever follow an http(s) link from the server (also strips
 *  control chars, so a URL can't smuggle an escape into an OSC-8 hyperlink). */
const safeUrl = (u) => {
	const s = clean(u);
	return /^https?:\/\//i.test(s) ? s : "";
};

/** Shared caches, session-scoped so concurrent sessions don't clobber. */
export const curCachePath = (sid) =>
	join(TMP, `entracte-cur-${String(sid || "x").replace(/[^\w-]/g, "")}.json`);
const ttlCachePath = (sid) =>
	join(TMP, `entracte-spin-${String(sid || "x").replace(/[^\w-]/g, "")}`);

/** Publisher slug written by `npx entracte login`, or null when unlinked. */
function machinePublisher() {
	try {
		return JSON.parse(readFileSync(CREDS, "utf8")).publisher || null;
	} catch {
		return null;
	}
}

function machineToken() {
	try {
		return JSON.parse(readFileSync(CREDS, "utf8")).token || null;
	} catch {
		return null;
	}
}

function keywordsFor(cwd) {
	const has = (f) => cwd && existsSync(join(cwd, f));
	if (has("adonisrc.ts")) return ["adonisjs", "typescript"];
	if (has("next.config.ts") || has("next.config.js"))
		return ["nextjs", "typescript"];
	if (has("Cargo.toml")) return ["rust"];
	if (has("go.mod")) return ["go"];
	if (has("requirements.txt") || has("pyproject.toml")) return ["python"];
	if (has("package.json")) return ["typescript"];
	return [];
}

/** Clip to n chars on a word boundary; add an ellipsis only when truncated. */
function wordClip(s, n) {
	const str = s.trim();
	if (str.length <= n) return str;
	const cut = str.slice(0, n);
	const sp = cut.lastIndexOf(" ");
	const base = (sp > n * 0.55 ? cut.slice(0, sp) : cut).replace(
		/[\s,;:.—–-]+$/,
		"",
	);
	return `${base}…`;
}

/**
 * Build a few clean spinner phrasings from one creative: the headline, the CTA,
 * and the body — each a distinct sponsor line, marked ✦.
 */
export function verbsFrom(creative) {
	// Finding H4: sanitize before these strings become spinnerVerbs in settings.json.
	const headline = clean(creative.headline || "").trim();
	const body = clean(creative.body || "").trim();
	const cta = clean(creative.cta || "").trim();
	const lead = headline || body;
	const out = [];
	if (lead) out.push(`${MARK} ${wordClip(lead, 44)}`);
	if (cta) out.push(`${MARK} ${wordClip(cta, 40)}`);
	if (headline && body && body !== headline)
		out.push(`${MARK} ${wordClip(body, 44)}`);
	return [...new Set(out)].filter((v) => v.length > 2);
}

/** The one-line status-line text (headline + body), clipped like the SL does. */
function statusText(creative) {
	// Finding H4: sanitize before this text is cached for the status line's stdout.
	let text =
		`${clean(creative.headline || "").trim()} ${clean(creative.body || "").trim()}`.trim();
	if (text.length > 58) text = `${text.slice(0, 57)}…`;
	return text;
}

/**
 * Fetch a pool of DISTINCT sponsors (one /api/serve/pool call — the backend
 * returns the top N advertisers, each a fresh offer + nonce). Returns the merged
 * spinner verbs (so Claude cycles the whole set while thinking) plus the
 * status-line pool (each sponsor's text + click/view URLs). Claude does NOT
 * hot-reload spinnerVerbs, so a multi-sponsor pool is how the frozen spinner
 * still varies within a session.
 */
export async function fetchPool({ cwd = "", token = null, n = 6 } = {}) {
	let data;
	try {
		const res = await fetch(`${API}/api/serve/pool`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				publisher: publisher(),
				adType: "entracte-text",
				surface: "terminal",
				keywords: keywordsFor(cwd),
				n,
				installId: installId() ?? undefined,
			}),
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return { verbs: [], sponsors: [] };
		data = await res.json();
	} catch {
		return { verbs: [], sponsors: [] };
	}
	const seen = new Set();
	const sponsors = [];
	const verbs = [];
	for (const s of data.sponsors || []) {
		const creative = { headline: s.headline, body: s.body, cta: s.cta };
		const text = statusText(creative);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		sponsors.push({
			text,
			// Finding H4: only cache http(s) links (safeUrl also strips control chars),
			// and strip control chars from the label the status line prints.
			clickUrl: safeUrl(s.clickUrl),
			viewUrl: safeUrl(s.viewUrl),
			label: clean(s.sponsoredLabel || "Sponsored"),
			badgeColor: s.badgeColor || null,
			textColor: s.textColor || null,
		});
		verbs.push(...verbsFrom(creative));
	}
	return { verbs: [...new Set(verbs)].slice(0, 10), sponsors };
}

/** Refresh the sponsor pool: rewrite spinnerVerbs + the shared SL pool cache. */
async function refresh(cwd, sid) {
	const ttl = ttlCachePath(sid);
	if (existsSync(ttl) && Date.now() - statSync(ttl).mtimeMs < TTL_MS) return;
	writeFileSync(ttl, "1"); // claim the window before the (slow) fetch

	const { verbs, sponsors } = await fetchPool({ cwd, token: machineToken() });
	if (!sponsors.length) return;

	// 1. spinner verbs — the whole pool, so Claude cycles sponsors while thinking
	//    (spinnerVerbs is read at session start; this seeds the next session too).
	let settings;
	try {
		settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
	} catch {
		settings = null; // no/invalid settings.json — skip spinner, still cache for SL
	}
	if (settings && verbs.length) {
		// Replace by default (the sponsor IS the thinking word); preserve "append"
		// if the user chose the mixed mode (`npx entracte --mixed`).
		const mode =
			settings.spinnerVerbs?.mode === "append" ? "append" : "replace";
		settings.spinnerVerbs = { mode, verbs };
		try {
			writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
		} catch {
			/* best effort */
		}
	}

	// 2. the shared pool the status line rotates through (clickable + metered)
	try {
		writeFileSync(
			curCachePath(sid),
			JSON.stringify({ sponsors, ts: Date.now() }),
		);
	} catch {
		/* best effort */
	}
}

async function main() {
	if (process.argv[2] === "--worker") {
		await refresh(process.argv[3] || process.cwd(), process.argv[4] || "");
		return;
	}

	// Hook invocation: read the payload for cwd + session_id, then hand off to a
	// detached worker and exit immediately with no stdout (keeps turns instant
	// and keeps our text out of Claude's context).
	let stdin = "";
	try {
		for await (const chunk of process.stdin) stdin += chunk;
	} catch {
		/* no stdin */
	}
	let cwd = process.cwd();
	let sid = "";
	try {
		const p = JSON.parse(stdin);
		cwd = p.cwd || p.workspace?.current_dir || cwd;
		sid = p.session_id || "";
	} catch {
		/* not JSON */
	}
	try {
		spawn(
			process.execPath,
			[fileURLToPath(import.meta.url), "--worker", cwd, sid],
			{ detached: true, stdio: "ignore" },
		).unref();
	} catch {
		/* best effort */
	}
}

// Run only when executed directly (as the hook or the --worker), not when the
// installer imports the helpers.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
