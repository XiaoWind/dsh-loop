/**
 * dsh-loop — a human-facing `/loop` slash command that runs the agent
 * on a timed, recurring loop.
 *
 * `/loop 30m` fires an immediate tick and then re-prompts the agent once per
 * 30-minute interval (measured from the moment the agent returns to idle after
 * the previous tick), until the human stops it with `/loop stop`.
 *
 * Loop config is persisted to `$DSH_HOME/dsh-loop/<sessionId>.json` so it
 * survives a restart. When a session with a saved loop is opened again, the
 * plugin asks whether to continue it (and falls back to a notice telling the
 * user to run `/loop resume` when no interactive prompt is available).
 *
 * @module dsh-loop
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { humanizeDuration, parseDurationMs } from "./duration.js";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Cordis function-plugin name, used in log labels. */
const name = "loop";

/** Services this plugin requires before it activates. */
const inject = ["commands", "agents", "userQuestions"];

/** Default interval for `/loop <objective>` (no leading duration token). */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** Directory under the DSH home holding one JSON file per saved loop. */
const STATE_DIR = "dsh-loop";

const USAGE =
  "Usage: /loop [<interval>] [<objective>] | /loop resume | /loop stop | /loop status";

const HELP = [
  "Runs the agent on a timed loop: an immediate tick, then one tick per interval.",
  "",
  "Examples:",
  "  /loop 30m                  loop every 30 minutes, keep the current objective",
  "  /loop 30m fix the tests    loop every 30 minutes toward an objective",
  "  /loop fix the tests        loop toward an objective, default interval",
  "  /loop 1h30m                combined durations are fine",
  "  /loop resume               resume the loop saved before a restart",
  "  /loop status               show the running loop",
  "  /loop stop                 stop the loop",
  "",
  "Intervals are a whitespace-free sequence of <number><unit> tokens where",
  "unit is one of ms, s, m, h, d (e.g. 90s, 30m, 1h30m, 2h).",
].join("\n");

/** Normalize the `defaultIntervalMs` plugin config to a safe value. */
function resolveDefaultInterval(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return DEFAULT_INTERVAL_MS;
}

// ── persistence ────────────────────────────────────────────────────────────

function statePath(sessionId) {
  return dshHomePath(STATE_DIR, `${sessionId}.json`);
}

function readState(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(sessionId), "utf8"));
    if (
      typeof parsed?.intervalMs === "number" &&
      Number.isFinite(parsed.intervalMs) &&
      parsed.intervalMs > 0
    ) {
      return {
        intervalMs: Math.round(parsed.intervalMs),
        objective:
          typeof parsed.objective === "string" && parsed.objective !== ""
            ? parsed.objective
            : null,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeState(sessionId, state) {
  const path = statePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state), "utf8");
}

function clearState(sessionId) {
  try {
    unlinkSync(statePath(sessionId));
  } catch {
    // Already absent.
  }
}

function isLive(ctx, agent) {
  try {
    return ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent);
  } catch {
    return false;
  }
}

function noticeMessage(text) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "loop", form: "notice", summary: text },
  });
}

/**
 * One live agent's loop state and timer. Installed on the agent's own context
 * so its timers are disposed with the agent; a plugin-level disposer also
 * stops every runtime on plugin teardown. Persistence is owned by the command
 * handlers, not the runtime, so disposal alone never discards a saved loop.
 */
class LoopRuntime {
  constructor(agent) {
    this.agent = agent;
    this.intervalMs = null;
    this.objective = null;
    this.ticks = 0;
    this.startedAt = null;
    this.nextTickAt = null;
    this.running = false;
    this.stopped = false;
    this.timer = null;
  }

  /** Start (or restart) the loop. First tick is immediate. */
  start(intervalMs, objective) {
    this.intervalMs = intervalMs;
    if (objective !== undefined && objective !== "") this.objective = objective;
    this.running = true;
    this.stopped = false;
    if (this.startedAt === null) this.startedAt = Date.now();
    this.arm(0);
  }

  /** Stop the loop and cancel its pending timer. */
  stop() {
    this.running = false;
    this.stopped = true;
    this.clearTimer();
  }

  clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Arm one timer segment; a fire invokes {@link drive}. */
  arm(delayMs) {
    this.clearTimer();
    if (!this.running || this.stopped) return;
    this.nextTickAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drive();
    }, delayMs);
  }

  /**
   * Fire one loop tick: claim the idle phase, queue a model-visible follow-up,
   * then re-arm after the agent returns to idle. When the agent is busy, wait
   * for idle before re-arming so a running turn is never interrupted.
   */
  async drive() {
    if (!this.running || this.stopped) return;
    this.clearTimer();

    let queued = false;
    try {
      queued = await this.agent.runMaintenance(() => {
        if (!this.running || this.stopped) return Promise.resolve(false);
        this.ticks += 1;
        this.agent.followup(this.tickMessage());
        return Promise.resolve(true);
      });
    } catch {
      // Another turn or maintenance task owns the agent right now.
      await this.waitForIdle();
      this.arm(this.intervalMs);
      return;
    }

    if (!this.running || this.stopped) return;
    if (queued) await this.waitForIdle();
    this.arm(this.intervalMs);
  }

  /** Await quiescence, contained so a failure never leaves a hung promise. */
  async waitForIdle() {
    if (!this.running) return;
    try {
      await this.agent.whenIdle();
    } catch {
      // Ignore idle-wait failures; the caller re-arms or stops by itself.
    }
  }

  /** Build the immutable follow-up message for one tick. */
  tickMessage() {
    const lines = [
      "[LOOP TICK]",
      `Scheduled loop tick #${this.ticks} (interval ${humanizeDuration(this.intervalMs)}).`,
    ];
    if (this.objective) {
      lines.push(`Objective: ${JSON.stringify(this.objective)}`);
      lines.push(
        "Continue working toward the objective above. Treat the workspace, tool " +
          "results, and durable session state as authoritative. Stop only when the " +
          "user runs /loop stop.",
      );
    } else {
      lines.push(
        "Continue working on your current task. Treat the workspace, tool results, " +
          "and durable session state as authoritative. The loop repeats once per " +
          "interval until the user runs /loop stop.",
      );
    }
    const text = lines.join("\n");
    return createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "plugin",
        plugin: "loop",
        form: "notice",
        summary: `Loop tick #${this.ticks}`,
      },
    });
  }

  /** Render the current loop state for `/loop` and `/loop status`. */
  status() {
    if (!this.running) {
      return { kind: "success", text: `No loop is running.\n${USAGE}` };
    }
    const lines = [
      "Loop is running.",
      `Interval: ${humanizeDuration(this.intervalMs)}`,
      `Ticks fired: ${this.ticks}`,
    ];
    if (this.objective) lines.push(`Objective: ${this.objective}`);
    if (this.nextTickAt !== null) {
      const remaining = Math.max(0, this.nextTickAt - Date.now());
      lines.push(`Next tick in: ${humanizeDuration(remaining)}`);
    }
    lines.push("", "Stop with /loop stop.");
    return { kind: "success", text: lines.join("\n") };
  }

  /** Confirmation text returned after `/loop` starts. */
  startedText() {
    const lines = ["Loop started."];
    lines.push(`Interval: ${humanizeDuration(this.intervalMs)}`);
    if (this.objective) lines.push(`Objective: ${this.objective}`);
    lines.push("First tick is immediate; then one tick per interval.");
    lines.push("", "Stop with /loop stop.");
    return lines.join("\n");
  }
}

/**
 * Execute one `/loop` invocation against the receiving agent.
 */
function executeCommand(ctx, invocation, state) {
  const input = (invocation.rawInput ?? "").trim();
  const lower = input.toLowerCase();
  const agent = invocation.agent;

  if (input.length === 0 || lower === "status") {
    return state.ensureRuntime(agent).status();
  }

  if (lower === "stop" || lower === "clear" || lower === "off") {
    return state.stopLoop(agent);
  }

  if (lower === "resume") {
    return state.resumeLoop(agent);
  }

  if (lower === "help") {
    return { kind: "success", text: HELP };
  }

  // A leading duration token is the interval; the rest is the objective.
  const first = input.split(/\s+/)[0];
  const interval = parseDurationMs(first);
  if (interval !== undefined) {
    const objective = input.slice(first.length).trim();
    const runtime = state.startLoop(agent, interval, objective === "" ? undefined : objective);
    return { kind: "success", text: runtime.startedText() };
  }

  // No leading duration: the whole input is the objective, using the default
  // interval (config.defaultIntervalMs).
  const runtime = state.startLoop(agent, state.defaultIntervalMs, input);
  return { kind: "success", text: runtime.startedText() };
}

/**
 * Ask whether to continue a saved loop, then act on the answer. Runs without
 * blocking the `agent/created` dispatch.
 */
async function maybeResumeLoop(ctx, agent, state) {
  const saved = readState(agent.id);
  if (saved === undefined) return;

  let choice;
  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      questions: [
        {
          id: "resume",
          header: "Loop",
          question: `Resume the loop saved before the restart? (${humanizeDuration(saved.intervalMs)}${
            saved.objective ? `, objective: ${saved.objective}` : ""
          })`,
          options: [{ label: "Continue" }, { label: "Stop" }],
        },
      ],
    });
    choice = answer.answers?.[0]?.selected?.[0];
  } catch {
    // No provider or the ask was aborted: keep the saved loop paused and tell
    // the user how to resume it manually.
    try {
      agent.inject(
        noticeMessage(
          "A loop is saved but not running. Run /loop resume to continue it, or /loop stop to discard it.",
        ),
      );
    } catch {
      // Agent already gone.
    }
    return;
  }

  if (!isLive(ctx, agent)) return;
  if (choice === "Continue") {
    if (state.runtimes.get(agent.id)?.runtime.running) return;
    state.startLoop(agent, saved.intervalMs, saved.objective ?? undefined);
  } else {
    clearState(agent.id);
  }
}

/**
 * Cordis function plugin. Registers the `/loop` command, owns the per-agent
 * loop runtimes, and resumes saved loops when a session is opened.
 */
function apply(ctx, config = {}) {
  const defaultIntervalMs = resolveDefaultInterval(config.defaultIntervalMs);
  const runtimes = new Map();

  const ensureRuntime = (agent) => {
    const existing = runtimes.get(agent.id);
    if (existing !== undefined) return existing.runtime;
    const runtime = new LoopRuntime(agent);
    const entry = { runtime, cleanup: null };
    entry.cleanup = agent.ctx.effect(() => () => {
      runtime.stop();
      if (runtimes.get(agent.id) === entry) runtimes.delete(agent.id);
    });
    runtimes.set(agent.id, entry);
    return runtime;
  };

  const startLoop = (agent, intervalMs, objective) => {
    const runtime = ensureRuntime(agent);
    runtime.start(intervalMs, objective);
    writeState(agent.id, { intervalMs, objective: runtime.objective });
    return runtime;
  };

  const stopLoop = (agent) => {
    const entry = runtimes.get(agent.id);
    const had = (entry !== undefined && entry.runtime.running) || readState(agent.id) !== undefined;
    clearState(agent.id);
    if (entry !== undefined) entry.runtime.stop();
    return { kind: "success", text: had ? "Loop stopped." : "No loop is running." };
  };

  const resumeLoop = (agent) => {
    const saved = readState(agent.id);
    if (saved === undefined) {
      return { kind: "error", text: "No saved loop to resume." };
    }
    const runtime = startLoop(agent, saved.intervalMs, saved.objective ?? undefined);
    return { kind: "success", text: runtime.startedText() };
  };

  const state = { defaultIntervalMs, runtimes, ensureRuntime, startLoop, stopLoop, resumeLoop };

  ctx.effect(() => {
    const dispose = ctx.commands.register({
      name: "loop",
      description: "run the agent on a timed loop (e.g. /loop 30m)",
      input: { hint: "[<interval>] [<objective>] | resume | stop | status" },
      handler: (invocation) => executeCommand(ctx, invocation, state),
    });
    const offCreated = ctx.on("agent/created", ({ agent }) => {
      try {
        if (!ctx.agents.roots().includes(agent)) return;
        void maybeResumeLoop(ctx, agent, state);
      } catch {
        // Never veto agent publication.
      }
    });
    return () => {
      offCreated();
      dispose();
      for (const { cleanup } of runtimes.values()) cleanup();
      runtimes.clear();
    };
  });
}

export { apply, inject, name };
