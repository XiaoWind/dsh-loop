# dsh-plugin-loop

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that adds a human-facing `/loop` slash command for **timed, recurring
agent loops** — the DSH equivalent of Claude Code's `/loop 30m`.

`/loop 30m` fires one immediate tick, then re-prompts the agent once per
30-minute interval (measured from the moment the agent returns to idle after
the previous tick) until you stop it with `/loop stop`.

## Install

```sh
dsh plugin --profile web add dsh-plugin-loop
```

The `dsh plugin` command forwards to `pnpm` inside the `web` profile directory,
then reconciles the profile's `dsh.profile.bundles` layer list. Because this
package declares `dsh.bundle.patch`, it joins the layer stack automatically.
Restart the Web app after installing.

> The plugin injects the `commands` service, so it activates only in profiles
> that compose a command adapter — the shipped `web` profile does.

## Usage

| Command | Result |
|---|---|
| `/loop 30m` | Start a loop: tick now, then once every 30 minutes. Keeps any current objective. |
| `/loop 30m fix the tests` | Start a 30-minute loop toward an objective. |
| `/loop fix the tests` | Start a loop toward an objective at the default interval. |
| `/loop 1h30m` | Combined durations are supported. |
| `/loop` or `/loop status` | Show the running loop. |
| `/loop stop` | Stop the loop. |
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
- **Process-local state.** The loop lives in memory for the lifetime of the live
  agent and is not persisted across restarts or session resumes. If you want a
  durable objective with "keep going until done" semantics, pair this with
  DSH's built-in `/goal` and the goal round driver.
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

# duration-parser unit test
node test/duration.test.mjs
```

The plugin is a single-file ESM Cordis function plugin (`lib/index.js`) with no
build step. It exports `apply`, `inject`, and `name`, and the bundle layer
`cordis.patch.yml` inserts it into the profile composition.

## License

MIT
