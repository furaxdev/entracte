#!/usr/bin/env node
import { spawn } from "node:child_process";
/**
 * entracte statusline (Node) — one cookieless sponsor line in Claude Code.
 *
 * Prefers the "current sponsor" the spinner worker publishes for this session
 * (`entracte-cur-<sid>.json`), so the bottom line shows the SAME sponsor as the
 * thinking spinner and rotates with it per turn. Falls back to its own /serve
 * when the spinner isn't installed. Fires the view beacon once per new sponsor
 * (server-side, only while the session is active). No deps. PolyForm-Noncommercial-1.0.0.
 */
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

// Anonymous per-machine install id (shared by the entracte terminal surfaces on
// this machine) so the network can count active installs. First-party only,
// never identity/IP-derived. INLINED (no import) so this file stays standalone
// when copied to ~/.claude/. Best-effort: any error just omits the id.
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
/**
 * Which publisher earns from this surface. `npx entracte login` records the
 * linked account's slug in credentials.json — without reading it, every
 * impression is credited to the house account and linking earns nothing.
 */
function publisher() {
	if (process.env.ENTRACTE_PUBLISHER) return process.env.ENTRACTE_PUBLISHER;
	try {
		const creds = join(
			process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
			"entracte",
			"credentials.json",
		);
		return JSON.parse(readFileSync(creds, "utf8")).publisher || "entracte";
	} catch {
		return "entracte";
	}
}
const TMP = process.env.TMPDIR || "/tmp";
const SELF_TTL_MS = 30_000; // fallback self-serve cache
const CUR_TTL_MS = 120_000; // trust the shared sponsor-pool cache this long
const ROTATE_MS = 8_000; // advance through the sponsor pool this often
const ACTIVE_MS = 300_000; // session counts as active if the transcript is recent

const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const badgeBg = "\x1b[48;5;99m"; // violet ≈ #875fff (entracte)
const badgeFg = "\x1b[97m"; // bright white

/**
 * Finding H4 (defense-in-depth): the server strips control chars, but a
 * compromised or OLDER server could inject terminal escapes through sponsor
 * copy (or an OSC-8 click URL). Strip control characters from ANY advertiser
 * text before it hits stdout, and only ever follow http(s) links. This holds
 * even if the shared pool cache was written by a stale spinner build.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping untrusted terminal control/escape chars
const CTRL = /[\x00-\x1F\x7F]/g;
const clean = (s) => String(s ?? "").replace(CTRL, "");
const safeUrl = (u) => {
	const s = clean(u);
	return /^https?:\/\//i.test(s) ? s : "";
};

async function readStdin() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	return input;
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

/** "#rrggbb" → "r;g;b" for ANSI truecolor, or null. */
function hexRgb(h) {
	const m = /^#?([0-9a-f]{6})$/i.exec((h || "").trim());
	if (!m) return null;
	const n = Number.parseInt(m[1], 16);
	return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

function renderLine(text, clickUrl, label, badgeColor, textColor) {
	// Finding H4: sanitize every advertiser-supplied field at the render boundary,
	// regardless of source (shared pool cache OR our own /serve fallback).
	const t = clean(text).trim();
	if (!t) return "";
	const url = safeUrl(clickUrl);
	const tag = clean(label || "Sponsored").toUpperCase();
	const sponsor = /^spons/i.test(tag);
	// Use the advertiser's OWN colours (truecolor) when set; else the entracte violet.
	// Content (motivation/news) is never a paid badge → a subtle tag.
	const bg = hexRgb(badgeColor);
	const fg = hexRgb(textColor);
	const badge = sponsor
		? `${bg ? `\x1b[48;2;${bg}m` : badgeBg}${fg ? `\x1b[38;2;${fg}m` : badgeFg}${bold} ${tag} ${reset}`
		: `${dim}${tag}${reset}`;
	const inner = url
		? `${badge} ${bold}${t}${reset} ${dim}↗${reset}`
		: `${badge} ${bold}${t}${reset}`;
	return url ? `\x1b]8;;${url}\x1b\\${inner}\x1b]8;;\x1b\\` : inner;
}

/** Fire the view beacon once per new sponsor, only while the session is active. */
function fireBeacon(viewUrl, sid, transcript) {
	// Finding H4: never hand curl anything but a clean http(s) URL.
	viewUrl = safeUrl(viewUrl);
	if (!viewUrl) return;
	const active =
		transcript &&
		existsSync(transcript) &&
		Date.now() - statSync(transcript).mtimeMs < ACTIVE_MS;
	if (!active) return;
	const fired = join(TMP, `entracte-sl-fired-${sid}`);
	try {
		if (readFileSync(fired, "utf8") === viewUrl) return; // already counted
	} catch {
		/* no prior */
	}
	try {
		writeFileSync(fired, viewUrl);
	} catch {
		/* best effort */
	}
	spawn("curl", ["-s", "-m", "3", viewUrl], {
		detached: true,
		stdio: "ignore",
	}).unref();
}

async function main() {
	let data;
	try {
		data = JSON.parse(await readStdin());
	} catch {
		return;
	}
	const sid = String(data.session_id || "x").replace(/[^\w-]/g, "");
	const cwd = data.workspace?.current_dir || data.cwd || "";
	const transcript = data.transcript_path || "";

	// 1. Prefer the shared sponsor POOL the spinner worker published, and rotate
	//    through it on a wall-clock index — so the bottom line cycles the same
	//    sponsors the spinner does. They can't be frame-identical: Claude Code
	//    freezes spinnerVerbs at session start and picks its own verb.
	const curFile = join(TMP, `entracte-cur-${sid}.json`);
	if (
		existsSync(curFile) &&
		Date.now() - statSync(curFile).mtimeMs < CUR_TTL_MS
	) {
		try {
			const pool = JSON.parse(readFileSync(curFile, "utf8")).sponsors;
			if (Array.isArray(pool) && pool.length) {
				const s = pool[Math.floor(Date.now() / ROTATE_MS) % pool.length];
				const line = renderLine(
					s.text,
					s.clickUrl,
					s.label,
					s.badgeColor,
					s.textColor,
				);
				if (line) {
					fireBeacon(s.viewUrl, sid, transcript);
					process.stdout.write(line);
					return;
				}
			}
		} catch {
			/* fall through to self-serve */
		}
	}

	// 2. Fallback: our own cookieless serve (spinner not installed / cache stale).
	const cache = join(TMP, `entracte-sl-${sid}`);
	if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < SELF_TTL_MS) {
		process.stdout.write(readFileSync(cache, "utf8"));
		return;
	}

	let decision;
	try {
		const res = await fetch(`${API}/api/serve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				publisher: publisher(),
				adType: "entracte-text",
				keywords: keywordsFor(cwd),
				installId: installId() ?? undefined,
			}),
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) throw new Error("bad status");
		decision = await res.json();
	} catch {
		if (existsSync(cache)) process.stdout.write(readFileSync(cache, "utf8"));
		return;
	}

	const c = decision.creative;
	if (!decision.filled || !c) return;
	let text = `${(c.headline || "").trim()} ${(c.body || "").trim()}`.trim();
	if (text.length > 58) text = `${text.slice(0, 57)}…`;
	const line = renderLine(
		text,
		decision.clickUrl,
		decision.sponsoredLabel,
		c.badgeColor,
		c.textColor,
	);
	writeFileSync(cache, line);
	fireBeacon(decision.viewUrl, sid, transcript);
	process.stdout.write(line);
}

main();
