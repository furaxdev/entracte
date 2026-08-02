import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRoot, createSignal, onCleanup } from "solid-js";

// TEMP debug: opencode swallows plugin errors, so we tee to a file we can read.
const DBG = "/tmp/entracte-oc-debug.log";
function dbg(msg: string) {
	try {
		appendFileSync(DBG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* ignore */
	}
}
dbg("=== module loaded ===");

/**
 * entracte opencode TUI plugin — a cookieless sponsor line in the opencode
 * working row (app_bottom slot). Not linked: prompts sign-in. Linked: shows the
 * sponsor + today's earnings, attributed to the dev's publisher via a machine
 * token (OAuth device flow). Reads no code, sets no cookies.
 */

const API = (process.env.ENTRACTE_API || "https://api.entracte.ai").replace(
	/\/$/,
	"",
);
const POLL_MS = 60_000;
const GREEN = "#10b981";
const AMBER = "#f59e0b";
const DIM = "#6b7280";
const CREDS = join(homedir(), ".config", "entracte", "credentials.json");
// A distinct install id for the opencode surface (so a machine that also runs
// the terminal CLI counts as a separate install). Anonymous, first-party only.
const INSTALL_ID_FILE = join(
	homedir(),
	".config",
	"entracte",
	"install-id-opencode",
);
function installId(): string | null {
	try {
		try {
			const v = readFileSync(INSTALL_ID_FILE, "utf8").trim();
			if (v) return v;
		} catch {
			/* not created yet */
		}
		const id = randomUUID();
		mkdirSync(dirname(INSTALL_ID_FILE), { recursive: true });
		writeFileSync(INSTALL_ID_FILE, id, { mode: 0o600 });
		return id;
	} catch {
		return null;
	}
}

/**
 * Finding H4 (defense-in-depth): the server strips control chars, but a
 * compromised or OLDER server could ship terminal escape / control characters
 * in sponsor copy that corrupt the opencode TUI row — or a non-http(s) click
 * URL handed to the OS opener. Strip control chars from all advertiser text and
 * only ever open/beacon http(s) links.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping untrusted terminal control/escape chars
const CTRL = /[\x00-\x1F\x7F]/g;
const clean = (s: string): string => String(s ?? "").replace(CTRL, "");
const safeUrl = (u: string): string => {
	const s = clean(u);
	return /^https?:\/\//i.test(s) ? s : "";
};

interface Ad {
	line: string;
	clickUrl: string;
	viewUrl: string;
	label: string;
}
interface Creds {
	token: string;
	publisher: string;
}

function readCreds(): Creds | null {
	try {
		return JSON.parse(readFileSync(CREDS, "utf8")) as Creds;
	} catch {
		return null;
	}
}
function writeCreds(c: Creds | null) {
	if (!c) {
		try {
			rmSync(CREDS);
		} catch {
			/* ignore */
		}
		return;
	}
	mkdirSync(dirname(CREDS), { recursive: true });
	writeFileSync(CREDS, JSON.stringify(c));
}

function openUrl(url: string) {
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

function authHeaders(token?: string): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	if (token) h.authorization = `Bearer ${token}`;
	return h;
}

async function fetchAd(token?: string): Promise<Ad | null> {
	try {
		const res = await fetch(`${API}/api/serve`, {
			method: "POST",
			headers: authHeaders(token),
			body: JSON.stringify({
				// A linked machine must serve for ITS OWN publisher, otherwise every
				// impression is credited to the house account and signing in — which
				// this plugin implements in full — earns the developer nothing.
				publisher: readCreds()?.publisher || "entracte",
				adType: "entracte-text",
				surface: "opencode",
				installId: installId() ?? undefined,
			}),
			signal: AbortSignal.timeout(4000),
		});
		if (!res.ok) return null;
		const d = (await res.json()) as {
			filled: boolean;
			creative: { headline: string; body: string } | null;
			clickUrl: string;
			viewUrl: string;
			sponsoredLabel?: string;
		};
		if (!d.filled || !d.creative) return null;
		// Finding H4: sanitize before this text renders in the TUI / a URL is opened.
		const line = clean(
			`${d.creative.headline ?? ""} ${d.creative.body ?? ""}`,
		).trim();
		return {
			line,
			clickUrl: safeUrl(d.clickUrl),
			viewUrl: safeUrl(d.viewUrl),
			label: clean(d.sponsoredLabel || "Sponsored"),
		};
	} catch {
		return null;
	}
}

async function fetchEarnings(token: string): Promise<number | null> {
	try {
		const res = await fetch(`${API}/api/publisher/stats`, {
			headers: authHeaders(token),
			signal: AbortSignal.timeout(4000),
		});
		if (!res.ok) return null;
		const d = (await res.json()) as { stats?: { earningsCents?: number } };
		return d.stats?.earningsCents ?? 0;
	} catch {
		return null;
	}
}

async function setContentMode(token: string, mode: string): Promise<boolean> {
	try {
		const res = await fetch(`${API}/api/publisher`, {
			method: "PATCH",
			headers: authHeaders(token),
			body: JSON.stringify({ contentMode: mode }),
			signal: AbortSignal.timeout(4000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function fmtUsd(cents: number): string {
	return `$${(cents / 100).toFixed(cents < 100 ? 4 : 2)}`;
}

// biome-ignore lint/suspicious/noExplicitAny: opencode's TUI api is untyped here
function initialize(api: any, dispose: () => void) {
	dbg(`initialize() api keys=[${Object.keys(api || {}).join(",")}]`);
	const [ad, setAd] = createSignal<Ad | null>(null);
	const [creds, setCreds] = createSignal<Creds | null>(readCreds());
	const [earnings, setEarnings] = createSignal<number | null>(null);
	const [linking, setLinking] = createSignal(false);
	// The device user-code, shown so the dev can sign in MANUALLY — opencode's
	// plugin runtime sandboxes child processes, so auto-opening the browser via
	// `open` silently fails. The code + entracte.ai/link always works.
	const [linkCode, setLinkCode] = createSignal<string | null>(null);
	let lastViewed = "";

	const refresh = async () => {
		const c = creds();
		const next = await fetchAd(c?.token);
		if (next) {
			setAd(next);
			if (next.viewUrl && next.viewUrl !== lastViewed) {
				lastViewed = next.viewUrl;
				void fetch(next.viewUrl, {
					headers: authHeaders(c?.token),
					signal: AbortSignal.timeout(3000),
				}).catch(() => {});
			}
		}
		if (c?.token) {
			const e = await fetchEarnings(c.token);
			if (e != null) setEarnings(e);
		}
	};

	// OAuth device flow: request a code, open the browser, poll until approved.
	const startLink = async () => {
		if (linking()) return;
		setLinking(true);
		try {
			const res = await fetch(`${API}/api/device/start`, {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ surface: "opencode" }),
			});
			const s = (await res.json()) as {
				deviceCode: string;
				userCode: string;
				verificationUrlComplete: string;
				interval: number;
				expiresIn: number;
			};
			setLinkCode(s.userCode);
			// Best-effort auto-open; sandboxed (no-op) in some TUIs — the code shown
			// in the status row is the reliable path.
			openUrl(s.verificationUrlComplete);
			const deadline = Date.now() + s.expiresIn * 1000;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, (s.interval || 5) * 1000));
				const pr = await fetch(`${API}/api/device/poll`, {
					method: "POST",
					headers: authHeaders(),
					body: JSON.stringify({ deviceCode: s.deviceCode }),
				});
				const p = (await pr.json()) as {
					status: string;
					machineToken?: string;
					publisher?: { slug?: string };
				};
				if (p.status === "ok" && p.machineToken) {
					const c: Creds = {
						token: p.machineToken,
						publisher: p.publisher?.slug ?? "you",
					};
					writeCreds(c);
					setCreds(c);
					void refresh();
					return;
				}
				if (p.status === "expired") return;
			}
		} catch {
			/* user can retry */
		} finally {
			setLinking(false);
			setLinkCode(null);
		}
	};

	const signOut = () => {
		writeCreds(null);
		setCreds(null);
		setEarnings(null);
	};

	// Switch what shows on this earner's surfaces: sponsors (earn) / quotes / news.
	const switchMode = async (mode: string) => {
		const c = creds();
		if (!c?.token) {
			void startLink();
			return;
		}
		if (await setContentMode(c.token, mode)) void refresh();
	};

	void refresh();
	const timer = setInterval(() => void refresh(), POLL_MS);
	onCleanup(() => clearInterval(timer));

	const handleClick = () => {
		if (!creds()) {
			void startLink();
			return;
		}
		const a = ad();
		if (a?.clickUrl) openUrl(a.clickUrl);
	};

	try {
		api.command?.register?.(() => [
			{
				title: "entracte: Sign in & earn",
				value: "entracte.signin",
				category: "entracte",
				slash: { name: "entractesignin" },
				onSelect: () => void startLink(),
			},
			{
				title: "entracte: Show sponsors (earn)",
				value: "entracte.mode.ads",
				category: "entracte",
				slash: { name: "entracteads" },
				onSelect: () => void switchMode("ads"),
			},
			{
				title: "entracte: Show motivation quotes",
				value: "entracte.mode.quotes",
				category: "entracte",
				slash: { name: "entractequotes" },
				onSelect: () => void switchMode("quotes"),
			},
			{
				title: "entracte: Show dev news",
				value: "entracte.mode.news",
				category: "entracte",
				slash: { name: "entractenews" },
				onSelect: () => void switchMode("news"),
			},
			{
				title: "entracte: Refresh",
				value: "entracte.refresh",
				category: "entracte",
				slash: { name: "entracterefresh" },
				onSelect: () => void refresh(),
			},
			{
				title: "entracte: Sign out",
				value: "entracte.signout",
				category: "entracte",
				slash: { name: "entractesignout" },
				onSelect: () => signOut(),
			},
		]);
	} catch (e) {
		dbg(
			`command.register ERROR: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	try {
		api.slots.register({
			slots: {
				app_bottom: () => (
					// biome-ignore lint/a11y/noStaticElementInteractions: opencode TUI element, not HTML
					<box height={1} overflow="hidden" onMouseDown={handleClick}>
						<text wrapMode="none" truncate={true}>
							<span style={{ fg: creds() ? GREEN : AMBER }}>{"◆ "}</span>
							{() => {
								if (linking()) {
									const code = linkCode();
									return code
										? `sign in → open entracte.ai/link · code ${code}`
										: "starting sign-in…";
								}
								if (!creds())
									return "entracte — click here to sign in & earn from sponsors";
								const a = ad();
								return a ? a.line : "loading sponsor…";
							}}
							<span style={{ fg: DIM }}>
								{() => {
									const a = ad();
									if (!creds() || !a) return "";
									const label = a.label || "Sponsored";
									const e = earnings();
									// Earnings only make sense for real sponsors; quotes/news = no pay.
									return label === "Sponsored" && e != null
										? `  · ${label} · ${fmtUsd(e)} today`
										: `  · ${label}`;
								}}
							</span>
						</text>
					</box>
				),
			},
		});
		dbg("slots.register OK");
	} catch (e) {
		dbg(`slots.register ERROR: ${e instanceof Error ? e.stack : String(e)}`);
	}

	api.lifecycle?.onDispose?.(() => dispose());
}

const plugin = {
	id: "entracte.tui",
	// biome-ignore lint/suspicious/noExplicitAny: opencode's TUI api is untyped here
	tui: async (api: any) => {
		dbg("tui() called");
		try {
			createRoot((dispose) => initialize(api, dispose));
		} catch (e) {
			dbg(`tui() ERROR: ${e instanceof Error ? e.stack : String(e)}`);
		}
	},
};

export default plugin;
