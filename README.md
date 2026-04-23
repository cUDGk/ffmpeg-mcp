<div align="center">

# ffmpeg-mcp

### ffmpeg / ffprobe を安全な引数渡しで LLM から叩く MCP サーバー

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat&logo=typescript&logoColor=white)](src/index.ts)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat&logo=node.js&logoColor=white)](package.json)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-7%2B-007808?style=flat&logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF?style=flat)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

**シェル文字列を組み立てずに ffmpeg を駆動する。probe は構造化 JSON で返す。**

---

</div>

## 概要

LLM に `ffmpeg -i ... -c:v libx264 ...` を文字列として書かせると、エスケープ事故・シェルインジェクション・クォート漏れが起きる。このサーバーは**全ての引数を配列で渡し、`spawn` でシェルを経由せずに起動する**。ffprobe は常に `-print_format json` で叩いて、LLM に渡す前に構造化する。

| 要素 | 実装 |
|---|---|
| トランスポート | stdio MCP |
| 子プロセス | `spawn(ffmpeg\|ffprobe, args[])` — シェル不使用 |
| 出力制御 | stderr 末尾 16 KB だけ残す (ffmpeg は verbose) |
| タイムアウト | 既定 600 s、`FFMPEG_TIMEOUT` または `timeout` 引数で上書き |

## 特徴

| アクション | 用途 |
|---|---|
| `probe` | ffprobe を JSON で叩き、format / streams / chapters を間引いて返す（未知ファイルへの第一手） |
| `convert` | 再エンコード。`video_codec` / `audio_codec` / `crf` / `preset` / `video_bitrate` / `audio_bitrate` / `fps` / `resolution=[w,h]` / オプションの `start`・`duration` / `extra_args` |
| `trim` | 既定で `-c copy` による**無劣化カット**（再エンコードなし、ほぼ瞬時）。`copy: false` で再エンコード可。**精度注意**: copy モードは I-frame 単位で seek する為、`start` が最大数秒ズレる事がある（ffmpeg の仕様）。フレーム精度が必要なら `copy: false` |
| `concat` | concat デマクサで `input_paths[]` を無劣化結合（全入力が同コーデック/同パラメータ前提） |
| `extract_audio` | `-vn` + オプションで `audio_codec` / `audio_bitrate`。拡張子でコーデック自動選択 |
| `thumbnail` | 指定時刻（既定 `00:00:01`）の 1 フレームを画像として書き出し、`size=[w,h]` で縮小可 |
| `run` | 生 args の escape hatch。`use_ffprobe: true` で ffprobe を叩く |
| `version` | `ffmpeg -version` / `ffprobe -version` の先頭行 |

## 処理フロー

```mermaid
sequenceDiagram
    participant LLM
    participant MCP as ffmpeg-mcp (stdio)
    participant FF as ffmpeg / ffprobe

    LLM->>MCP: {action: "probe", input: "in.mp4"}
    MCP->>FF: spawn(ffprobe, [-v error, -print_format json, -show_format, -show_streams, ...])
    FF-->>MCP: stdout (JSON)
    MCP->>MCP: JSON.parse + 間引き
    MCP-->>LLM: {format, streams[], chapters[]}

    LLM->>MCP: {action: "convert", input, output, crf: 23, preset: "medium"}
    MCP->>FF: spawn(ffmpeg, [-y, -i, in.mp4, -crf, 23, -preset, medium, out.mp4])
    FF-->>MCP: exit_code / stdout / stderr(tail) / duration_ms
    MCP-->>LLM: JSON
```

## インストール

```bash
git clone https://github.com/cUDGk/ffmpeg-mcp.git
cd ffmpeg-mcp
npm install
npm run build
```

ffmpeg と ffprobe が PATH にある事が前提。別パスにある場合は `FFMPEG_PATH` / `FFPROBE_PATH` で明示する。

## 使い方

### Claude Code に登録

```bash
claude mcp add ffmpeg -- node C:/Users/user/Desktop/ffmpeg-mcp/dist/index.js
```

### 環境変数

| 変数 | デフォルト | 用途 |
|---|---|---|
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg 実行ファイル |
| `FFPROBE_PATH` | `ffprobe` | ffprobe 実行ファイル |
| `FFMPEG_TIMEOUT` | `600000` | 単一呼び出しのタイムアウト (ms) |

### 呼び出し例

未知ファイルの確認 → 中央 10 秒を切り出し → H.264 に再圧縮:

```json
{"action": "probe", "input": "C:/tmp/raw.mkv"}

{"action": "trim", "input": "C:/tmp/raw.mkv", "output": "C:/tmp/clip.mkv",
 "start": "00:01:00", "duration": 10}

{"action": "convert", "input": "C:/tmp/clip.mkv", "output": "C:/tmp/out.mp4",
 "video_codec": "libx264", "crf": 23, "preset": "medium",
 "audio_codec": "aac", "audio_bitrate": "128k"}
```

サムネイル 4 枚（0 / 10 / 20 / 30 秒）:

```json
{"action": "thumbnail", "input": "in.mp4", "output": "t0.jpg", "time": 0, "size": [640, 360]}
{"action": "thumbnail", "input": "in.mp4", "output": "t1.jpg", "time": 10, "size": [640, 360]}
{"action": "thumbnail", "input": "in.mp4", "output": "t2.jpg", "time": 20, "size": [640, 360]}
{"action": "thumbnail", "input": "in.mp4", "output": "t3.jpg", "time": 30, "size": [640, 360]}
```

`run` で完全制御（例: フィルタ複雑グラフ）:

```json
{"action": "run", "args": [
  "-y", "-i", "in.mp4",
  "-filter_complex", "[0:v]scale=1280:720,fps=30[v]",
  "-map", "[v]", "-map", "0:a",
  "-c:v", "libx264", "-crf", "20",
  "out.mp4"
]}
```

## 設計メモ

- **意図ベースのアクション（`convert_to_mp4` 等）を増やさない**。増やしても結局 `extra_args` で逃げるだけで、LLM に覚えさせる面が増える。アクションは**処理のカテゴリ単位**（convert / trim / concat / thumbnail）に留める。
- **stderr は末尾 16 KB だけ残す**。ffmpeg は 1 回の実行で数 MB のログを吐く事があり、LLM のコンテキストを焼き尽くす。
- **相対パスは CWD から resolve**。LLM が相対パスを渡しても意図通りの場所に書き出される。
- **タイムアウト既定 10 分**。長時間エンコードは `timeout` で上書き。

## Attribution

- [FFmpeg](https://ffmpeg.org/) © FFmpeg developers（LGPL/GPL）— 本 MCP はラッパーであり FFmpeg 本体のライセンスに従う
- [Model Context Protocol](https://modelcontextprotocol.io/) — 仕様・SDK

## ライセンス

MIT License © 2026 cUDGk — 詳細は [LICENSE](LICENSE) を参照。
