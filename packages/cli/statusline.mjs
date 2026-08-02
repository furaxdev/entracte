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
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WriteStream } from "node:tty";

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
const badgeBg = "\x1b[48;2;255;212;52m"; // entracte yellow #ffd434
const badgeFg = "\x1b[38;2;11;15;21m"; // near-black, as on the site

// Rounded badge caps (Nerd Font half circles, U+E0B6 / U+E0B4). Terminals
// without a Nerd Font show tofu, and a few leave a hairline seam where the cap
// meets the coloured body — ENTRACTE_BADGE=square drops the caps entirely.
const ROUND = process.env.ENTRACTE_BADGE !== "square";
const CAP_L = "\uE0B6";
const CAP_R = "\uE0B4";

// The wordmark gradient, sampled off the entracte lockup: teal → blue → violet →
// orange, one truecolor stop per letter of "entracte".
const MARK_TEAL = "\x1b[38;2;25;186;160m";
const WORDMARK = [
	[0x28, 0xbb, 0xcb],
	[0x38, 0xbc, 0xf6],
	[0x4f, 0xb2, 0xf5],
	[0x67, 0xa7, 0xf5],
	[0x96, 0x92, 0xf6],
	[0x9f, 0x7e, 0xb5],
	[0xc6, 0x92, 0x98],
	[0xcd, 0x90, 0x61],
];

// The badge steps through the brand colours, one per refresh. Interpolating the
// ramp instead would only crawl — the status line redraws every 10s, so a smooth
// gradient reads as "the colour never really changes". Snapping to whole stops
// makes each redraw visibly different. ENTRACTE_BADGE_STATIC=1 pins it.
const STEP_MS = 10_000; // matches the installer's statusLine refreshInterval
const badgeFill = () => {
	if (process.env.ENTRACTE_BADGE_STATIC) return WORDMARK[0];
	return WORDMARK[Math.floor(Date.now() / STEP_MS) % WORDMARK.length];
};

// Visible width of "◆ entracte" — diamond + space + 8 letters.
const MARK_COLS = 10;
// One glanceable sentence. Wider terminals get more padding, not more copy.
const MAX_COPY = 58;

/** Trim to `n` columns, backing off to the last word boundary when there is one. */
function ellipsize(s, n) {
	const cut = s.slice(0, n - 1);
	const sp = cut.lastIndexOf(" ");
	return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

/** Printable columns, ignoring SGR colour codes and OSC 8 hyperlink wrappers. */
function visibleWidth(s) {
	return [
		...s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
	].length;
}

/**
 * Terminal width, or null when it can't be known. Claude Code pipes our stdout,
 * so `process.stdout.columns` is undefined and COLUMNS usually isn't exported —
 * ENTRACTE_COLS lets people pin it when they want a flush-right wordmark.
 */
function termCols() {
	const pinned = Number.parseInt(process.env.ENTRACTE_COLS || "", 10);
	const inherited = Number.parseInt(process.env.COLUMNS || "", 10);
	// Claude Code renders the status line inside its own chrome and clips the tail,
	// so filling the terminal edge-to-edge loses the last few cells — and the
	// wordmark sits exactly there. Hold back a margin (tune with ENTRACTE_MARGIN).
	const margin = Number.parseInt(process.env.ENTRACTE_MARGIN || "", 10);
	// Erring large is cheap (a little gap at the right edge); erring small clips
	// the wordmark, which is the whole point of aligning it there.
	const keep = (c) =>
		c ? Math.max(20, c - (Number.isFinite(margin) ? margin : 4)) : null;
	// ENTRACTE_COLS is a deliberate override, so it's honoured verbatim. COLUMNS is
	// just the terminal's own width — Claude Code indents the status line inside
	// it, so that one still needs the margin or the tail gets clipped.
	if (Number.isFinite(pinned) && pinned > 20) return pinned;

	// Ask the controlling terminal FIRST: COLUMNS is captured when the shell
	// starts and goes stale the moment the window is resized, whereas /dev/tty
	// reports the live size. Fails harmlessly (ENXIO) when there's no tty.
	let fd = null;
	try {
		fd = openSync("/dev/tty", "r+");
		const cols = new WriteStream(fd).columns;
		if (cols > 20) return keep(cols);
	} catch {
		/* fall through to the inherited hints below */
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}

	if (process.stdout.columns) return keep(process.stdout.columns);
	if (Number.isFinite(inherited) && inherited > 20) return keep(inherited);
	return null;
}

/** Wrap a rendered line in an OSC 8 hyperlink. */
function link(inner, url) {
	return `\x1b]8;;${url}\x1b\\${inner}\x1b]8;;\x1b\\`;
}

/** "◆ entracte" — teal diamond + the gradient wordmark. */
function brandMark() {
	const word = [..."entracte"]
		.map((ch, i) => {
			const [r, g, b] = WORDMARK[i] ?? WORDMARK[WORDMARK.length - 1];
			return `\x1b[38;2;${r};${g};${b}m${ch}`;
		})
		.join("");
	return `${MARK_TEAL}◆${reset} ${bold}${word}${reset}`;
}

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
	// An advertiser's own colours always win — a paid badge must look like the
	// brand that paid for it. Only the entracte default gets the drifting fill.
	const fill = bg || badgeFill().join(";");
	// Pick the text colour from the fill's luminance so a pale fill gets near
	// black and a saturated one gets white, instead of a fixed pair that goes
	// unreadable half the cycle.
	const [fr, fg_, fb] = fill.split(";").map(Number);
	const luma = (0.299 * fr + 0.587 * fg_ + 0.114 * fb) / 255;
	const ink = fg
		? `\x1b[38;2;${fg}m`
		: luma > 0.6
			? "\x1b[38;2;11;15;21m"
			: "\x1b[38;2;255;255;255m";
	// Caps are FOREGROUND glyphs in the fill colour, so they blend into whatever
	// background the terminal uses.
	const cap = (glyph) => (ROUND ? `\x1b[38;2;${fill}m${glyph}${reset}` : "");
	const badge = sponsor
		? `${cap(CAP_L)}\x1b[48;2;${fill}m${ink}${bold}${ROUND ? "" : " "}${tag}${ROUND ? "" : " "}${reset}${cap(CAP_R)}`
		: `${dim}${tag}${reset}`;
	// The wordmark rides along with paid badges only — content modes (motivation,
	// news) aren't entracte inventory, so they stay unbranded.
	const mkBody = (copy) =>
		url
			? `${badge} ${bold}${copy}${reset} ${dim}↗${reset}`
			: `${badge} ${bold}${copy}${reset}`;
	if (!sponsor) return url ? link(mkBody(t), url) : mkBody(t);

	// Wordmark sits at the END of the line, as on the entracte lockup. When the
	// width is known we reserve its columns FIRST and shorten the advertiser copy
	// to fit — otherwise the terminal clips the line and eats the mark itself.
	const cols = termCols();
	// A status line is a glance, not a paragraph: the copy stays capped at one
	// short sentence however wide the terminal is. Extra width becomes padding
	// that pushes the wordmark right — it never becomes more advertiser text.
	const fits = cols
		? cols - visibleWidth(mkBody("")) - MARK_COLS - 1
		: MAX_COPY - MARK_COLS;
	const room = Math.min(fits, MAX_COPY);
	let copy = t;
	if (room > 1 && copy.length > room) copy = `${ellipsize(copy, room)}…`;
	const body = mkBody(copy);
	const used = visibleWidth(body) + MARK_COLS;
	const pad = cols && cols > used ? " ".repeat(cols - used) : " ";
	// Only the sponsor copy is clickable — the entracte mark stays outside the
	// advertiser's hyperlink.
	return `${url ? link(body, url) : body}${pad}${brandMark()}`;
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
	// Hard cap only — renderLine does the real fitting, since it's the one that
	// knows the badge width, the wordmark and the terminal size.
	if (text.length > 160) text = `${text.slice(0, 159)}…`;
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
