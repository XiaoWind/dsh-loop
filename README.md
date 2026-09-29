# dsh-loop

中文 | [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）
插件，新增人机交互用的 `/loop` 斜杠命令，实现**定时循环**。

`/loop 30m` 会立即触发一次，之后每隔 30 分钟（从上一次触发后 agent 回到空闲
状态起算）再次提醒 agent 继续工作，直到你用 `/loop stop` 停止。

## 安装

### DeepSeek Harness 桌面版

在桌面版的**插件管理**里添加插件时，填 GitHub 规格（注意不是包名）：

```
github:XiaoWind/dsh-loop
```

桌面版会在 profile 目录里执行 `pnpm add github:XiaoWind/dsh-loop`，从 GitHub
拉取默认分支的最新 commit，校验通过后把本包加入 `dsh.profile.bundles`。
**安装后按提示重启桌面应用**才会生效。

> **必须使用 `github:owner/repo` 这种规格。** 本插件没有发布到 npm registry，
> 只写 `dsh-loop` 会去 npm 上查找，安装会失败。

> 桌面版在安装时会逐条校验本插件 `peerDependencies` 里的 `@deepseek-ai/dsh-*`
> 范围是否接受当前运行时版本（即 `dsh-app-boot` 的版本，例如 `0.2.0-rc.2`）。
> 不兼容时会拒绝安装，并回滚 `package.json`、`pnpm-lock.yaml` 和
> `node_modules`；遇到这种情况请更新到最新版插件。

### CLI / Web 版

```sh
# 从 GitHub 安装（立即可用，无需发布到 npm）
dsh plugin --profile web add github:XiaoWind/dsh-loop

# 等价写法
dsh plugin --profile web add git+https://github.com/XiaoWind/dsh-loop.git
```

`dsh plugin` 会把参数转发给 `web` profile 目录内的 `pnpm`，随后自动把该包加入
`dsh.profile.bundles` 层级列表（因为本包声明了 `dsh.bundle.patch`）。安装后请
重启 Web 应用。

> 本插件注入 `commands` 服务，因此只在包含命令适配器的 profile 中生效——官方
> 自带的 `web` profile 就包含它。

## 更新

**桌面版**：在插件管理里重新安装该插件，或先移除再按
`github:XiaoWind/dsh-loop` 重新添加。pnpm 可能缓存旧的 git 解析结果，移除后重新
添加最可靠；更新后重启桌面应用。

**CLI / Web 版**：

```sh
dsh plugin --profile web update dsh-loop
```

`dsh plugin` 会把参数转发给 profile 目录里的 `pnpm update dsh-loop`，把
`github:XiaoWind/dsh-loop` 重新解析到默认分支的最新 commit。锁文件按 commit
钉住 git 依赖，因此不必升级 `version` 也能更新。若 pnpm 因缓存没有拉到新
commit，可显式重新钉一次：

```sh
dsh plugin --profile web add github:XiaoWind/dsh-loop
```

更新后请重启应用——bundle 层在启动时组合，运行中的进程不会热更已安装的插件。

## 用法

| 命令 | 作用 |
|---|---|
| `/loop 30m` | 启动循环：立即触发一次，之后每 30 分钟一次；保留已有目标。 |
| `/loop 30m 修好测试` | 以 30 分钟为间隔，围绕一个目标循环。 |
| `/loop 修好测试` | 围绕目标循环，使用默认间隔。 |
| `/loop 1h30m` | 支持组合时长。 |
| `/loop resume` | 恢复重启前保存的循环。 |
| `/loop` 或 `/loop status` | 查看当前循环状态。 |
| `/loop stop` | 停止循环。 |
| `/loop help` | 查看帮助。 |

间隔是「数字 + 单位」的无空格序列，单位可选 `ms`、`s`、`m`、`h`、`d`，例如
`90s`、`30m`、`1h30m`、`2h`。

开头的时长 token 是间隔，其余部分是目标；没有开头时长时，整个输入即目标，并
使用默认间隔。

### 语义

- **首次立即触发。** 之后的每次触发都在 agent 回到空闲状态后等待一个间隔再进
  行，因此绝不会打断正在进行的回合。
- **跨重启保存。** 循环配置持久化到 `$DSH_HOME/dsh-loop/<sessionId>.json`。重启
  后重新打开该会话时，插件会询问是否继续已保存的循环（「继续」/「停止」）；若
  没有可用的交互提示，可用 `/loop resume` 手动恢复，`/loop stop` 则丢弃已保存的
  循环。
- **手动停止。** 循环会一直运行，直到你执行 `/loop stop`、agent 被销毁或插件被
  卸载；没有自动完成检测。

## 配置

可通过 `config.defaultIntervalMs`（毫秒）修改「`/loop <目标>` 未给出间隔」时使用
的默认间隔，缺省为 `600000`（10 分钟）。

```yaml
# 你的 profile 的 cordis.patch.yml
- id: loop
  config:
    defaultIntervalMs: 900000
```

## 开发

```sh
# 语法检查
node --check lib/index.js
```

插件是单文件 ESM Cordis 函数插件（`lib/index.js`），无需构建步骤。它导出
`apply`、`inject`、`name`，并由 bundle 层 `cordis.patch.yml` 插入到 profile 组合中。

## License

MIT
