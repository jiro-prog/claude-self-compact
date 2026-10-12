# self-compact

[English](README.md) | 日本語

[Claude Code](https://code.claude.com) の会話を、トークン量ではなく作業の区切りで compact する plugin です（function hooks で作っています）。

Claude Code は、会話が上限に近づくと compact します。決めるのはトークン量です。この plugin は、作業の中身で決まる引き金を 2 つ足します。

- **`compact_here`**：作業の一区切りがついた時に Claude が呼ぶ道具です。区切りとは、調べ物の答えが出た、チケットを commit した、話題が変わる、といった時です。Claude は要約に残すものを自分で書きます。そのターンが終わると、plugin がその指示で compact します。
- **離席中の compact**：大きな会話が 50 分放置されたら、プロンプトキャッシュが切れる前に compact します。

## なぜ要るのか

Claude はターンのたびに会話をまるごと読み直します。その大半はプロンプトキャッシュからの読み込みです。トークンあたりは安くても、モデルを呼ぶたびに毎回かかります。長い調べ物の会話が数十万トークンまで膨らむと、1 回の呼び出しは新しい会話の何倍もかかります。細部が要らなくなった時点で compact すれば、流れを失わずに会話を小さく保てます。何が大事かを分かっているモデル自身が、残すものを選ぶからです。

プロンプトキャッシュは 1 時間で切れます。放置した大きな会話に戻ると、文脈全体がキャッシュ書き込みの値段で書き直されます。切れる少し前に compact しておけば、書き直すのは要約だけで済みます。

## 導入

```sh
claude plugin marketplace add jiro-prog/claude-self-compact
claude plugin install self-compact@self-compact
```

function hooks を有効にする必要があるかもしれません。`~/.claude/settings.json` に次を足します。

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

新しいセッションを始める（か `/reload-plugins` を実行する）と、Claude の道具一覧に `mcp__self-compact__compact_here` が並びます。

## 設定

`/config`（この plugin の行）か、`settings.json` の `pluginConfigs["self-compact"].options` で変えられます。

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `minTokens` | `60000` | 文脈がこれより小さい時は `compact_here` を断る |
| `idleCompact` | `true` | 離席中の compact をするかどうか |
| `idleMinutes` | `50` | 最後のターンから何分で離席中の compact をするか。キャッシュの寿命（60 分）より短くしておく |
| `idleMinTokens` | `150000` | 文脈がこれ以上の時だけ、離席中の compact をする |

どの要約にも残したいものがあるなら、`CLAUDE.md` に `## Compact Instructions` の節を足してください。要約役は、この plugin が起こす compact も含めて、毎回この節を読みます。

## 仕組み

- `session.start` で `$.tool.register({ ..., isDeferred: false })` を使って道具を登録します。ToolSearch の裏に回さないので、モデルは説明文を読めます。`tool.describe` の hook でも同じ指定をしています。
- 道具を呼んでも、その場では指示を預かるだけです。ターンが終わると、`turn.complete`（本線の会話だけ）が `$.session.compact({ instructions })` を実行します。次のターンがもう始まっていて断られた時は、そのターンの終わりまで持ち越します。ターンを中断した時は取り消します。
- 同じ `turn.complete` で離席中の compact のタイマーを仕掛け、`turn.start` で止めます。
- subagent はこの道具を呼べません。subagent のターンも数えません。

## 制限

- 画面のあるセッションでしか動きません。画面のない実行（`claude -p`・SDK）では `$.session.compact` がまだ使えません。その時、この plugin は道具を出さず、タイマーも仕掛けません。
- 離席中の compact は、Claude Code のプロンプトキャッシュが 1 時間であることを前提にしています。キャッシュが 5 分なら、会話は小さくなりますが、その時にはキャッシュはもう切れています。
- function hooks は Claude Code の新しい API です。この plugin は Claude Code 2.1.296 で作って確かめました。2.1.294 より前の `$.tool.register` は `isDeferred` を無視します。2.1.289 では、`tool.describe` で指定しても、`/reload-plugins` の後に道具が ToolSearch の裏に回りました。その場合、モデルは道具を読み込むまで名前しか見えません。

## 開発

```sh
claude plugin validate plugins/self-compact
claude plugin test plugins/self-compact
```

## ライセンス

MIT
