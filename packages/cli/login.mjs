#!/usr/bin/env node
/**
 * `npx entracte login` — link this machine to your entracte account with the
 * same OAuth device flow the opencode plugin uses: ask the API for a user code,
 * show it, open the browser, poll until it's approved. Writes the machine token
 * to ~/.config/entracte/credentials.json, which statusline.mjs, spinner.mjs and
 * entracte-mode.mjs already read. No deps. PolyForm-Noncommercial-1.0.0.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const API = (process.env.ENTRACTE_API || "https://api.entracte.ai").replace(
	/\/$/,
	"",
);
const CREDS = join(
	process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
	"entracte",
	"credentials.json",
);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Best-effort browser open — the printed code is always the reliable path. */
function openUrl(url) {
	const cmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd"
				: "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		/* best effort */
	}
}

async function post(path, body) {
	const res = await fetch(`${API}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	});
	return await res.json();
}

const fail = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};

// 1. request a device code
let start;
try {
	start = await post("/api/device/start", { surface: "claude-code" });
} catch (err) {
	fail(`Couldn't reach entracte (${err.message}). Try again shortly.`);
}
if (!start?.deviceCode || !start?.userCode) {
	fail("Couldn't start the login. Try again shortly.");
}

const {
	deviceCode,
	userCode,
	verificationUrlComplete = "https://entracte.ai/link",
	interval = 5,
	expiresIn = 900,
} = start;

// 2. show the code, send them to the browser
console.log(bold("\nentracte — link this machine\n"));
console.log(`  Your code:  ${bold(green(userCode))}`);
console.log(`  Open:       ${verificationUrlComplete}\n`);
console.log(dim("  Waiting for you to confirm it… (Ctrl-C to cancel)"));
openUrl(verificationUrlComplete);

// 3. poll until approved or expired
const deadline = Date.now() + expiresIn * 1000;
let creds = null;

while (Date.now() < deadline) {
	await sleep((interval || 5) * 1000);
	let p;
	try {
		p = await post("/api/device/poll", { deviceCode });
	} catch {
		continue; // transient blip — the deadline still bounds the wait
	}
	if (p?.status === "ok" && p.machineToken) {
		creds = { token: p.machineToken, publisher: p.publisher?.slug ?? "you" };
		break;
	}
	if (p?.status === "expired") break;
}

if (!creds) {
	fail("The code expired before it was confirmed. Run `npx entracte login` again.");
}

// 4. persist — this is a bearer token, so keep it owner-only
mkdirSync(dirname(CREDS), { recursive: true });
writeFileSync(CREDS, JSON.stringify(creds));
try {
	chmodSync(CREDS, 0o600);
} catch {
	/* some filesystems don't support it — not fatal */
}

console.log(green("\n✓ Machine linked.") + dim(` Saved to ${CREDS}`));
console.log(dim("  Switch content:  /entracte <ads|quotes|news>  (in Claude Code)"));
