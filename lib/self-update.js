/**
 * Shared runtime self-update support for the dsh-* plugins.
 *
 * Each plugin asks GitHub for the newest commit of its own repository, reads
 * the `version` in that commit's `package.json`, and — when that version is
 * newer than the running one — hands the plugin manager a Git spec pinned to
 * that commit. On a desktop profile the manager hot-reloads the plugin, so the
 * new version starts at once; the new instance reports the result through the
 * notice channel below.
 *
 * This file deliberately imports only Node builtins so the same copy can live
 * in dsh-cron, dsh-loop and dsh-vault and be unit-tested standalone. Keep the
 * three copies byte-identical.
 *
 * Safety rules:
 * - Nothing is installed unless the profile lists the plugin as an installed,
 *   git-sourced bundle (`update === 'git'`), which requires a dependency pinned
 *   to a full 40-character commit. An unpinned install is left alone.
 * - A lock file keeps the three plugins from running pnpm at the same time.
 * - All failures are recorded and reported, never thrown out of the timer.
 *
 * @module lib/self-update
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Default span between checks once the first check ran. */
const DEFAULT_INTERVAL_MS = 6 * HOUR;
/** Default delay before the first check after a plugin (re)starts. */
const DEFAULT_INITIAL_DELAY_MS = 90_000;
/** A check that finds the update lock busy retries after this delay. */
const LOCK_RETRY_MS = 10 * MINUTE;
/** Locks older than this are considered abandoned by a crashed process. */
const LOCK_STALE_MS = 15 * MINUTE;
/** Notices older than this are dropped instead of delivered. */
const NOTICE_TTL_MS = 30 * 24 * HOUR;
/** Per-request timeout against GitHub. */
const REQUEST_TIMEOUT_MS = 10_000;

const USER_AGENT = "dsh-plugin-self-update";

/** True when the deployment explicitly opted out of automatic updates. */
function autoUpdateDisabledByEnvironment() {
  return process.env.DSH_PLUGIN_AUTO_UPDATE === "0";
}

function positiveNumber(value, fallback, minimum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

// ── semver ────────────────────────────────────────────────────────────────

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    String(value ?? "").trim(),
  );
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/u.test(a);
  const bNumeric = /^\d+$/u.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two semantic versions, build metadata ignored.
 *
 * @returns {number} negative when `a` precedes `b`, positive when it follows,
 *   zero when they are equal; an unparseable `a` or `b` sorts first.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    const leftText = String(a ?? "");
    const rightText = String(b ?? "");
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  }
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const order = compareIdentifiers(leftPart, rightPart);
    if (order !== 0) return order;
  }
  return 0;
}

/** True when `candidate` is a strict semantic-version successor of `current`. */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

// ── persisted state ───────────────────────────────────────────────────────

function statePath(stateRoot, plugin) {
  return join(stateRoot, `${plugin}.json`);
}

/**
 * Read the update state for one plugin. Missing or corrupt state reads as an
 * empty record; update state is advisory and never worth crashing over.
 */
export function readUpdateState(stateRoot, plugin) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(statePath(stateRoot, plugin), "utf8"));
  } catch {
    return emptyState();
  }
  if (parsed === null || typeof parsed !== "object") return emptyState();
  return {
    lastCheckAt: typeof parsed.lastCheckAt === "number" ? parsed.lastCheckAt : 0,
    lastCheckSha: typeof parsed.lastCheckSha === "string" ? parsed.lastCheckSha : "",
    lastError:
      parsed.lastError !== null && typeof parsed.lastError === "object" &&
      typeof parsed.lastError.message === "string"
        ? { at: Number(parsed.lastError.at) || 0, message: parsed.lastError.message }
        : null,
    attempt:
      parsed.attempt !== null && typeof parsed.attempt === "object" &&
      typeof parsed.attempt.version === "string" && typeof parsed.attempt.sha === "string" &&
      typeof parsed.attempt.from === "string" && typeof parsed.attempt.at === "number"
        ? { version: parsed.attempt.version, sha: parsed.attempt.sha, from: parsed.attempt.from, at: parsed.attempt.at }
        : null,
    notice:
      parsed.notice !== null && typeof parsed.notice === "object" &&
      typeof parsed.notice.text === "string" && typeof parsed.notice.at === "number"
        ? { text: parsed.notice.text, at: parsed.notice.at }
        : null,
  };
}

function emptyState() {
  return { lastCheckAt: 0, lastCheckSha: "", lastError: null, attempt: null, notice: null };
}

/** Replace the update state atomically (write a sibling file, then rename). */
export function writeUpdateState(stateRoot, plugin, state) {
  mkdirSync(stateRoot, { recursive: true });
  const path = statePath(stateRoot, plugin);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, path);
}

// ── cross-plugin lock ─────────────────────────────────────────────────────

function lockPath(stateRoot) {
  return join(stateRoot, "update.lock");
}

/**
 * Take the shared update lock without blocking.
 *
 * @returns {boolean} whether this caller now owns the lock.
 */
export function acquireUpdateLock(stateRoot, now = Date.now()) {
  mkdirSync(stateRoot, { recursive: true });
  const path = lockPath(stateRoot);
  try {
    const handle = openSync(path, "wx");
    try {
      writeSync(handle, JSON.stringify({ pid: process.pid, at: now }));
    } finally {
      closeSync(handle);
    }
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (now - statSync(path).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(path);
        return acquireUpdateLock(stateRoot, now);
      }
    } catch {
      // The lock vanished between the open and the stat; fall through as busy.
    }
    return false;
  }
}

/** Release the shared update lock; a missing lock is already released. */
export function releaseUpdateLock(stateRoot) {
  try {
    unlinkSync(lockPath(stateRoot));
  } catch {
    // Already gone.
  }
}

// ── GitHub lookup ─────────────────────────────────────────────────────────

function requestHeaders(token) {
  const headers = { accept: "application/vnd.github+json", "user-agent": USER_AGENT };
  if (typeof token === "string" && token !== "") headers.authorization = `Bearer ${token}`;
  return headers;
}

function timeoutSignal(milliseconds) {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(milliseconds) : undefined;
}

async function fetchText(fetchImpl, url, options) {
  const response = await fetchImpl(url, {
    headers: requestHeaders(options.token),
    signal: timeoutSignal(positiveNumber(options.timeoutMs, REQUEST_TIMEOUT_MS, 1_000)),
  });
  if (response.ok !== true) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  }
  return response.text();
}

/**
 * Ask GitHub for the repository's newest commit and the version its
 * `package.json` carries.
 *
 * @returns {Promise<{status: 'current'|'newer', sha: string, version: string}>}
 * @throws when the repository, the manifest, or its name/version is unusable.
 */
export async function checkForNewerVersion(options) {
  const { repo, packageName, currentVersion, fetchImpl = globalThis.fetch } = options;
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation is available");
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  const commitsUrl = `https://api.github.com/repos/${repo}/commits?per_page=1`;
  const commits = JSON.parse(await fetchText(fetchImpl, commitsUrl, { token, timeoutMs: options.timeoutMs }));
  const sha = Array.isArray(commits) && commits.length > 0 ? String(commits[0]?.sha ?? "") : "";
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`GitHub returned no usable commit for ${repo}`);
  }

  const manifestUrl = `https://raw.githubusercontent.com/${repo}/${sha}/package.json`;
  const manifest = JSON.parse(await fetchText(fetchImpl, manifestUrl, { token, timeoutMs: options.timeoutMs }));
  if (manifest?.name !== packageName) {
    throw new Error(`${manifestUrl} declares package "${String(manifest?.name)}", expected "${packageName}"`);
  }
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (parseVersion(version) === null) {
    throw new Error(`${manifestUrl} carries an invalid version "${version}"`);
  }

  return { sha, version, status: isNewerVersion(version, currentVersion) ? "newer" : "current" };
}

// ── agent-facing helpers ──────────────────────────────────────────────────

/** The live root agents (never subagents), tolerant of an absent registry. */
function liveRootAgents(ctx) {
  try {
    const registry = typeof ctx.get === "function" ? ctx.get("agents") : ctx.agents;
    const agents = typeof registry?.list === "function" ? registry.list() : [];
    return agents.filter((agent) => agent?.session?.header?.origin !== "subagent");
  } catch {
    return [];
  }
}

/**
 * One-line description of a check result, for the plugin's `/update` toggle.
 */
export function describeUpdateResult(result, packageName) {
  switch (result?.status) {
    case "current":
      return `${packageName} ${result.version ?? ""} is the newest commit on GitHub.`.trim();
    case "updated":
      return `Updated ${packageName} to ${result.version ?? "the newest version"}; it reloads now.`;
    case "pending":
      return `An update of ${packageName} to ${result.version ?? "a newer version"} is already in progress.`;
    case "unpinned":
      return `Auto-update is inactive: install ${packageName} from a commit-pinned spec (github:XiaoWind/${packageName}#<40-character sha>) to enable it.`;
    case "unmanaged":
      return "Auto-update is unavailable: this runtime has no plugin manager.";
    case "locked":
      return "Another DSH plugin is updating right now; the check runs again shortly.";
    case "throttled":
      return `Checked ${packageName} recently; the next automatic check is due later.`;
    case "stopped":
      return "Auto-update is disabled for this plugin.";
    case "error":
      return `Checking ${packageName} for updates failed: ${result.error ?? "unknown error"}`;
    default:
      return `${packageName} update check finished (${String(result?.status ?? "unknown")}).`;
  }
}

// ── install ───────────────────────────────────────────────────────────────

/**
 * Wire runtime self-update into a plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Owning plugin context.
 * @param {object} options
 * @param {string} options.plugin Short plugin name, e.g. `cron`.
 * @param {string} options.packageName npm package name, e.g. `dsh-cron`.
 * @param {string} options.repo GitHub `owner/name`.
 * @param {string} options.currentVersion Version the running code reports.
 * @param {string} options.stateRoot Absolute directory for state and lock files.
 * @param {(text: string) => object} options.notice Builds the notice message
 *   injected into an agent (the plugin owns the message shape).
 * @param {(level: 'info'|'warn', message: string) => void} [options.log]
 * @param {object} [options.config] Plugin config: `autoUpdate`,
 *   `updateCheckIntervalMs`, `updateInitialDelayMs`.
 * @param {Function} [options.fetchImpl] Test seam.
 * @param {object} [options.manager] Test seam for the plugin manager service.
 * @returns {object} `{ checkNow, pumpNotices, dispose }`.
 */
export function installSelfUpdate(ctx, options) {
  const {
    plugin,
    packageName,
    repo,
    currentVersion,
    stateRoot,
    notice,
    config = {},
    fetchImpl = globalThis.fetch,
    manager: managerOverride,
  } = options;
  const log = typeof options.log === "function" ? options.log : () => {};
  const intervalMs = positiveNumber(config.updateCheckIntervalMs, DEFAULT_INTERVAL_MS, 5 * MINUTE);
  const initialDelayMs = positiveNumber(config.updateInitialDelayMs, DEFAULT_INITIAL_DELAY_MS, 5_000);
  const enabled = config.autoUpdate !== false && !autoUpdateDisabledByEnvironment();

  let disposed = false;
  let timer = null;
  let inFlight = false;

  const state = () => readUpdateState(stateRoot, plugin);
  const save = (value) => writeUpdateState(stateRoot, plugin, value);

  function noticeFor(text) {
    return { text: typeof text === "string" ? text : String(text) };
  }

  function pushNotice(text) {
    if (disposed) return;
    const next = state();
    next.notice = { text, at: Date.now() };
    save(next);
  }

  /** Turn a recorded attempt into a success or failure notice on (re)start. */
  function reconcileAttempt() {
    const current = state();
    if (current.attempt === null) return;
    const attempt = current.attempt;
    current.attempt = null;
    if (attempt.version === currentVersion) {
      current.notice = {
        text: `${packageName} updated itself from ${attempt.from} to ${attempt.version} and reloaded.`,
        at: Date.now(),
      };
      current.lastError = null;
    } else {
      current.notice = {
        text: `Automatic update of ${packageName} from ${attempt.from} to ${attempt.version} did not complete; it is still ${attempt.from}. The next check retries.`,
        at: Date.now(),
      };
    }
    save(current);
  }

  /** Deliver one pending notice to any live root agent, then clear it. */
  function pumpNotices() {
    if (disposed) return;
    const current = state();
    if (current.notice === null) return;
    if (Date.now() - current.notice.at > NOTICE_TTL_MS) {
      current.notice = null;
      save(current);
      return;
    }
    const targets = liveRootAgents(ctx);
    for (const agent of targets) {
      let delivered = false;
      try {
        const message = notice(current.notice.text);
        agent.inject(message);
        delivered = true;
      } catch {
        // A busy or disposed agent is retried on its next creation.
      }
      if (delivered) {
        const fresh = state();
        if (fresh.notice !== null && fresh.notice.at === current.notice.at) {
          fresh.notice = null;
          save(fresh);
        }
        return;
      }
    }
  }

  function recordFailure(error) {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    const current = state();
    current.lastError = { at: Date.now(), message: message.slice(0, 500) };
    current.lastCheckAt = Date.now();
    save(current);
    log("warn", `update check failed: ${message}`);
  }

  function managerFor(ctx2) {
    if (managerOverride !== undefined) return managerOverride;
    try {
      return typeof ctx2.get === "function" ? ctx2.get("pluginManager") : undefined;
    } catch {
      return undefined;
    }
  }

  async function checkNow(options2 = {}) {
    if (disposed) return { status: "stopped" };
    if (inFlight) return { status: "throttled" };
    inFlight = true;
    try {
      return await runCheck(options2);
    } finally {
      inFlight = false;
    }
  }

  async function runCheck(options2) {
    const manual = options2.manual === true;
    const current = state();
    const now = Date.now();
    if (!manual && current.lastCheckAt > 0 && now - current.lastCheckAt < intervalMs) {
      return { status: "throttled" };
    }
    const manager = managerFor(ctx);
    if (manager === undefined || typeof manager.listBundles !== "function" || typeof manager.updateBundle !== "function") {
      return { status: "unmanaged" };
    }

    let bundles;
    try {
      bundles = await manager.listBundles();
    } catch (error) {
      recordFailure(error);
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    if (disposed) return { status: "stopped" };
    const own = Array.isArray(bundles) ? bundles.find((bundle) => bundle?.name === packageName) : undefined;
    if (own === undefined || own.installed !== true || own.update !== "git") {
      current.lastCheckAt = now;
      current.lastError = null;
      save(current);
      log("info", `auto-update stays off until ${packageName} is installed from a commit-pinned spec`);
      return { status: "unpinned" };
    }

    let target;
    try {
      target = await checkForNewerVersion({ repo, packageName, currentVersion, fetchImpl });
    } catch (error) {
      recordFailure(error);
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    if (disposed) return { status: "stopped" };

    const latest = state();
    latest.lastCheckAt = Date.now();
    latest.lastCheckSha = target.sha;
    latest.lastError = null;
    save(latest);

    if (target.status !== "newer") {
      return { status: "current", version: target.version, sha: target.sha };
    }
    if (latest.attempt !== null) {
      return { status: "pending", version: latest.attempt.version };
    }
    if (!acquireUpdateLock(stateRoot)) return { status: "locked" };

    latest.attempt = { version: target.version, sha: target.sha, from: currentVersion, at: Date.now() };
    save(latest);
    log("info", `updating ${packageName} ${currentVersion} -> ${target.version} (${target.sha.slice(0, 7)})`);

    try {
      const spec = `github:${repo}#${target.sha}`;
      const outcome = await manager.updateBundle(packageName, target.version, { spec });
      const application = outcome?.result?.application;
      log("info", `update of ${packageName} to ${target.version}: ${String(application ?? "unknown")}`);
      // With hot reload the new instance reports success; when the manager
      // needed a restart, this instance is still the one users see.
      if (!disposed && application === "restart-required") {
        pushNotice(`${packageName} ${target.version} is installed and loads after DSH restarts.`);
        const settled = state();
        if (settled.attempt?.sha === target.sha) {
          settled.attempt = null;
          save(settled);
        }
      }
      return { status: "updated", version: target.version, sha: target.sha, application };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!disposed) {
        const failed = state();
        failed.attempt = null;
        failed.lastError = { at: Date.now(), message: message.slice(0, 500) };
        failed.notice = {
          text: `Automatic update of ${packageName} to ${target.version} failed: ${message.slice(0, 300)}. ${packageName} stays at ${currentVersion}.`,
          at: Date.now(),
        };
        save(failed);
      }
      log("warn", `update to ${target.version} failed: ${message}`);
      return { status: "error", error: message, version: target.version };
    } finally {
      releaseUpdateLock(stateRoot);
    }
  }

  function schedule(delay) {
    if (disposed || !enabled) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
    timer.unref?.();
  }

  async function tick() {
    let delay = intervalMs;
    try {
      const result = await checkNow();
      if (result.status === "locked") delay = LOCK_RETRY_MS;
    } catch (error) {
      recordFailure(error);
    }
    schedule(delay);
  }

  reconcileAttempt();

  if (typeof ctx.effect === "function") {
    ctx.effect(() => {
      const offCreated = typeof ctx.on === "function" ? ctx.on("agent/created", () => pumpNotices()) : () => {};
      schedule(initialDelayMs);
      return () => {
        disposed = true;
        offCreated();
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    });
  }
  pumpNotices();

  const dispose = () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return { checkNow, pumpNotices, dispose };
}
