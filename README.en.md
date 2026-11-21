# dsh-loop

[中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that adds a human-facing `/loop` slash command for **timed, recurring
agent loops**.

`/loop 30m` fires one immediate tick, then re-prompts the agent once per
30-minute interval (measured from the moment the agent returns to idle after
the previous tick) until you stop it with `/loop stop`.

## Install

### DeepSeek Harness Desktop

Add the plugin in the desktop app's plugin manager using a GitHub spec — not the
package name:

```
github:XiaoWind/dsh-loop#<40-char commit sha>
```

**Pin the full 40-character commit.** DSH's plugin manager only reports
`update: 'git'` (and allows a hot update) for a git source pinned to a full
commit; that pin is also what the runtime auto-update below needs. A plain
`github:XiaoWind/dsh-loop` spec still installs, but auto-update stays off.

The desktop app runs `pnpm add` in its profile directory, checks this package's
`engines.dsh` (`>=0.2.2-rc.5 <0.3.0`) against the running DSH version, and adds
the package to `dsh.profile.bundles` once it passes. An incompatible plugin is
refused and `package.json`, `pnpm-lock.yaml`, and `node_modules` are rolled
back. **Restart the desktop app when prompted** for the plugin to take effect.

> **The `github:owner/repo` spec is required.** This plugin is not published to
> the npm registry, so a bare `dsh-loop` would be looked up on npm and the
> installation would fail.

### CLI / Web

```sh
# from GitHub, pinned to a full commit (required for auto-update)
dsh plugin --profile web add "github:XiaoWind/dsh-loop#<40-char commit sha>"

# or install from the default branch (auto-update stays off)
dsh plugin --profile web add github:XiaoWind/dsh-loop
```

The `dsh plugin` command forwards to `pnpm` inside the `web` profile directory,
then reconciles the profile's `dsh.profile.bundles` layer list. Because this
package declares `dsh.bundle.patch`, it joins the layer stack automatically.
Restart the Web app after installing.

> The plugin injects the `commands` service, so it activates only in profiles
> that compose a command adapter — the shipped `web` profile does.

## Auto-update

The plugin updates itself at runtime, no external script required:

1. About 90 seconds after start — then every 6 hours — it checks the latest
   commit on GitHub for `XiaoWind/dsh-loop`;
2. it reads that commit's `package.json` and only updates when `version` is
   newer than the running one;
3. it hot-updates the installed plugin to that commit through the DSH plugin
   manager (a git spec pinned to the 40-char sha). Profiles with HMR enabled —
   including the desktop app — remove and reload the plugin in place, no restart
   needed;
4. success or failure is reported as a session notice; a failure leaves the
   running version untouched and the next check retries.

**Prerequisite**: the plugin must be installed with a full-commit spec (see
Install). A non-pinned install never auto-updates; `/loop update` tells you how
to reinstall.

Tune it in the profile's `cordis.patch.yml`:

```yaml
- id: loop
  config:
    autoUpdate: true                 # false disables the checks
    updateCheckIntervalMs: 21600000  # between checks (default 6 hours)
    updateInitialDelayMs: 90000      # first check (default 90 seconds)
```

Set `DSH_PLUGIN_AUTO_UPDATE=0` to disable auto-update for all plugins. Checks
use `api.github.com` and `raw.githubusercontent.com`; set `GITHUB_TOKEN` if you
hit unauthenticated rate limits. Trigger a check manually with `/loop update`.

### Manual update (when auto-update is off)

**Desktop**: remove the plugin in the plugin manager and add it again with a
pinned spec; restart the app afterwards.

**CLI / Web**:

```sh
dsh plugin --profile web update dsh-loop
# or pin a specific commit explicitly
dsh plugin --profile web add "github:XiaoWind/dsh-loop#<new commit sha>"
```

Restart the app after updating — the bundle layer is composed at boot, so a
running process does not hot-reload an installed plugin unless HMR is enabled.

## Usage

| Command | Result |
|---|---|
| `/loop 30m` | Start a loop: tick now, then once every 30 minutes. Keeps any current objective. |
| `/loop 30m fix the tests` | Start a 30-minute loop toward an objective. |
| `/loop fix the tests` | Start a loop toward an objective at the default interval. |
| `/loop 1h30m` | Combined durations are supported. |
| `/loop resume` | Resume the loop saved before a restart. |
| `/loop` or `/loop status` | Show the running loop. |
| `/loop stop` | Stop the loop. |
| `/loop update` | Check for a plugin update now. |
| `/loop help` | Show help. |

Intervals are a whitespace-free sequence of `<number><unit>` tokens where
`unit` is one of `ms`, `s`, `m`, `h`, `d` — for example `90s`, `30m`, `1h30m`,
`2h`.

A leading duration token is the interval and the remainder is the objective;
with no leading duration, the whole input is the objective and the default
interval applies.

### Semantics

- **First tick is immediate.** Each later tick fires `interval` after the agent
  returns to idle, so a running turn is never interrupted.
- **Saved across restarts.** The loop config is persisted to
  `$DSH_HOME/dsh-loop/<sessionId>.json`. When you reopen the session after a
  restart, the plugin asks whether to continue the saved loop (`Continue` /
  `Stop`); `/loop resume` restarts it manually when no prompt is available.
  `/loop stop` discards the saved loop.
- **Manual stop.** The loop runs until you run `/loop stop`, the agent is
  disposed, or the plugin is unloaded. There is no automatic completion
  detection.

## Configuration

Set `config.defaultIntervalMs` (milliseconds) to change the interval used by a
bare `/loop <objective>` with no leading duration token. The default is
`600000` (10 minutes).

```yaml
# your profile's cordis.patch.yml
- id: loop
  config:
    defaultIntervalMs: 900000
```

## Development

```sh
# syntax check
node --check lib/index.js
node --check lib/self-update.js
```

The plugin is a single-file ESM Cordis function plugin (`lib/index.js`) with no
build step. It exports `apply`, `inject`, and `name`, and the bundle layer
`cordis.patch.yml` inserts it into the profile composition.

## License

MIT
