#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const DEFAULT_TIMEOUT = parseInt(process.env.FFMPEG_TIMEOUT || "600000", 10);
const MAX_STDERR = 16384;

type RunResult = {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
};

function killProc(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore" });
      return;
    } catch {}
  }
  try { proc.kill("SIGKILL"); } catch {}
}

function runCmd(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<RunResult> {
  const t0 = Date.now();
  const to = opts.timeout ?? DEFAULT_TIMEOUT;
  return new Promise((res) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProc(proc);
    }, to);
    proc.stdout!.on("data", (c) => { stdout += c.toString("utf8"); });
    proc.stderr!.on("data", (c) => {
      stderr += c.toString("utf8");
      if (stderr.length > MAX_STDERR * 2) stderr = stderr.slice(-MAX_STDERR);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      res({
        exit_code: null, signal: null, stdout,
        stderr: `spawn error: ${err.message}. Is "${cmd}" on PATH?`,
        duration_ms: Date.now() - t0, timed_out: false,
      });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
      res({
        exit_code: code, signal: signal ?? null, stdout, stderr,
        duration_ms: Date.now() - t0, timed_out: timedOut,
      });
    });
  });
}

function textContent(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function errContent(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function runResponse(r: RunResult) {
  const res = textContent(r);
  if (r.exit_code !== 0) (res as any).isError = true;
  return res;
}

function okResponse(data: { ok: boolean } & Record<string, unknown>) {
  const res = textContent(data);
  if (!data.ok) (res as any).isError = true;
  return res;
}

async function probe(input: string) {
  const r = await runCmd(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-show_chapters",
    resolve(input),
  ], { timeout: 60000 });
  if (r.exit_code !== 0) {
    return { ok: false as const, exit_code: r.exit_code, stderr: r.stderr };
  }
  try {
    const data = JSON.parse(r.stdout);
    const streams = (data.streams || []).map((s: any) => ({
      index: s.index,
      codec_type: s.codec_type,
      codec_name: s.codec_name,
      codec_long_name: s.codec_long_name,
      profile: s.profile,
      width: s.width,
      height: s.height,
      coded_width: s.coded_width,
      coded_height: s.coded_height,
      display_aspect_ratio: s.display_aspect_ratio,
      sample_aspect_ratio: s.sample_aspect_ratio,
      pix_fmt: s.pix_fmt,
      color_space: s.color_space,
      color_range: s.color_range,
      color_transfer: s.color_transfer,
      color_primaries: s.color_primaries,
      field_order: s.field_order,
      r_frame_rate: s.r_frame_rate,
      avg_frame_rate: s.avg_frame_rate,
      nb_frames: s.nb_frames,
      sample_rate: s.sample_rate,
      channels: s.channels,
      channel_layout: s.channel_layout,
      bit_rate: s.bit_rate,
      duration: s.duration,
      time_base: s.time_base,
      disposition: s.disposition,
      tags: s.tags,
    }));
    return {
      ok: true as const,
      format: data.format && {
        filename: data.format.filename,
        format_name: data.format.format_name,
        format_long_name: data.format.format_long_name,
        duration: data.format.duration,
        size: data.format.size,
        bit_rate: data.format.bit_rate,
        nb_streams: data.format.nb_streams,
        tags: data.format.tags,
      },
      streams,
      chapters: data.chapters || [],
    };
  } catch (e: any) {
    return { ok: false as const, error: `ffprobe json parse failed: ${e.message}`, raw: r.stdout.slice(0, 1000) };
  }
}

function buildConvertArgs(p: {
  input: string; output: string;
  video_codec?: string; audio_codec?: string;
  crf?: number; preset?: string;
  video_bitrate?: string; audio_bitrate?: string;
  fps?: number; resolution?: [number, number];
  start?: string | number; duration?: string | number;
  overwrite?: boolean;
  extra_args?: string[];
}): string[] {
  const args: string[] = [];
  args.push(p.overwrite === false ? "-n" : "-y");
  if (p.start !== undefined) args.push("-ss", String(p.start));
  args.push("-i", resolve(p.input));
  if (p.duration !== undefined) args.push("-t", String(p.duration));
  if (p.video_codec) args.push("-c:v", p.video_codec);
  if (p.audio_codec) args.push("-c:a", p.audio_codec);
  if (p.crf !== undefined) args.push("-crf", String(p.crf));
  if (p.preset) args.push("-preset", p.preset);
  if (p.video_bitrate) args.push("-b:v", p.video_bitrate);
  if (p.audio_bitrate) args.push("-b:a", p.audio_bitrate);
  if (p.fps !== undefined) args.push("-r", String(p.fps));
  if (p.resolution) args.push("-s", `${p.resolution[0]}x${p.resolution[1]}`);
  if (p.extra_args) args.push(...p.extra_args);
  args.push(resolve(p.output));
  return args;
}

async function convert(p: any) {
  const args = buildConvertArgs(p);
  return runCmd(FFMPEG, args, { timeout: p.timeout });
}

async function trim(p: {
  input: string; output: string;
  start: string | number; end?: string | number; duration?: string | number;
  copy?: boolean; overwrite?: boolean; timeout?: number;
}) {
  const args: string[] = [];
  args.push(p.overwrite === false ? "-n" : "-y");
  args.push("-ss", String(p.start));
  args.push("-i", resolve(p.input));
  if (p.end !== undefined) args.push("-to", String(p.end));
  else if (p.duration !== undefined) args.push("-t", String(p.duration));
  if (p.copy !== false) args.push("-c", "copy");
  args.push(resolve(p.output));
  return runCmd(FFMPEG, args, { timeout: p.timeout });
}

async function concat(p: { input_paths: string[]; output: string; overwrite?: boolean; timeout?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "ffmpeg-mcp-"));
  const listFile = join(dir, "list.txt");
  try {
    const body = p.input_paths
      .map((f) => `file '${resolve(f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    writeFileSync(listFile, body, "utf8");
    const args = [
      p.overwrite === false ? "-n" : "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      resolve(p.output),
    ];
    return await runCmd(FFMPEG, args, { timeout: p.timeout });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function extractAudio(p: {
  input: string; output: string; audio_codec?: string;
  audio_bitrate?: string; overwrite?: boolean; timeout?: number;
}) {
  const args: string[] = [];
  args.push(p.overwrite === false ? "-n" : "-y");
  args.push("-i", resolve(p.input));
  args.push("-vn");
  if (p.audio_codec) args.push("-c:a", p.audio_codec);
  if (p.audio_bitrate) args.push("-b:a", p.audio_bitrate);
  args.push(resolve(p.output));
  return runCmd(FFMPEG, args, { timeout: p.timeout });
}

async function thumbnail(p: {
  input: string; output: string;
  time?: string | number; size?: [number, number]; overwrite?: boolean; timeout?: number;
}) {
  const t = p.time ?? 0;
  const args: string[] = [];
  args.push(p.overwrite === false ? "-n" : "-y");
  args.push("-ss", String(t));
  args.push("-i", resolve(p.input));
  args.push("-frames:v", "1");
  if (p.size) args.push("-s", `${p.size[0]}x${p.size[1]}`);
  args.push(resolve(p.output));
  return runCmd(FFMPEG, args, { timeout: p.timeout });
}

async function run(p: { args: string[]; use_ffprobe?: boolean; timeout?: number }) {
  const cmd = p.use_ffprobe ? FFPROBE : FFMPEG;
  return runCmd(cmd, p.args, { timeout: p.timeout });
}

async function version() {
  const [m, p] = await Promise.all([
    runCmd(FFMPEG, ["-version"], { timeout: 10000 }),
    runCmd(FFPROBE, ["-version"], { timeout: 10000 }),
  ]);
  const firstLine = (s: string) => (s.split(/\r?\n/)[0] ?? "").trim();
  return {
    ffmpeg: firstLine(m.stdout) || firstLine(m.stderr),
    ffprobe: firstLine(p.stdout) || firstLine(p.stderr),
  };
}

const server = new McpServer({ name: "ffmpeg", version: "0.1.0" });

server.tool(
  "ffmpeg",
  `Invoke ffmpeg / ffprobe with safe argument passing (no shell).

Actions:
- probe: ffprobe → structured JSON (format + streams + chapters). Always try this first on unknown files.
- convert: re-encode input → output. Supports video_codec, audio_codec, crf, preset, video_bitrate, audio_bitrate, fps, resolution=[w,h], optional start/duration trim, extra_args.
- trim: fast cut. Default copy=true uses stream-copy (no re-encode, near-instant).
- concat: stream-copy concatenation of input_paths[] via the concat demuxer. All inputs must share codec/params.
- extract_audio: -vn + optional audio_codec/audio_bitrate. Codec often inferable from output extension.
- thumbnail: single-frame PNG/JPEG at time (default 00:00:01), optional size=[w,h].
- run: raw passthrough. args=[string,...]. Set use_ffprobe=true to invoke ffprobe instead.
- version: ffmpeg -version / ffprobe -version first lines.

Paths are resolved to absolute. stderr is truncated to the last 16 KB. Default per-call timeout 600000 ms; set env FFMPEG_TIMEOUT or pass timeout (run/convert) to override.`,
  {
    action: z.enum([
      "probe", "convert", "trim", "concat",
      "extract_audio", "thumbnail", "run", "version",
    ]).describe("Action to perform"),
    input: z.string().optional().describe("Input file path (probe/convert/trim/extract_audio/thumbnail)"),
    output: z.string().optional().describe("Output file path"),
    input_paths: z.array(z.string()).optional().describe("Input paths for concat"),
    args: z.array(z.string()).optional().describe("Raw args for the 'run' action"),
    use_ffprobe: z.boolean().optional().describe("run: invoke ffprobe instead of ffmpeg"),
    video_codec: z.string().optional().describe("e.g. libx264, libvpx-vp9, copy"),
    audio_codec: z.string().optional().describe("e.g. aac, libmp3lame, libopus, copy"),
    crf: z.number().optional().describe("x264/x265/VP9 quality (lower = better). x264 typical 18-28"),
    preset: z.string().optional().describe("x264 preset: ultrafast..veryslow"),
    video_bitrate: z.string().optional().describe("e.g. '2M'"),
    audio_bitrate: z.string().optional().describe("e.g. '192k'"),
    fps: z.number().optional().describe("Output frame rate"),
    resolution: z.array(z.number()).length(2).optional().describe("[width, height]"),
    start: z.union([z.string(), z.number()]).optional().describe("Seek start (sec or hh:mm:ss)"),
    end: z.union([z.string(), z.number()]).optional().describe("trim: end time"),
    duration: z.union([z.string(), z.number()]).optional().describe("Duration (sec or hh:mm:ss)"),
    copy: z.boolean().optional().describe("trim: stream copy mode (default true)"),
    time: z.union([z.string(), z.number()]).optional().describe("thumbnail: frame time"),
    size: z.array(z.number()).length(2).optional().describe("thumbnail: [w,h]"),
    overwrite: z.boolean().optional().describe("Overwrite existing output (default true)"),
    extra_args: z.array(z.string()).optional().describe("convert: extra ffmpeg args"),
    timeout: z.number().optional().describe("Per-call timeout ms (run/convert)"),
  },
  async (params) => {
    const a = params.action;
    try {
      if (a === "probe") {
        if (!params.input) return errContent("probe requires 'input'");
        return okResponse(await probe(params.input));
      }
      if (a === "convert") {
        if (!params.input || !params.output) return errContent("convert requires 'input' and 'output'");
        return runResponse(await convert(params));
      }
      if (a === "trim") {
        if (!params.input || !params.output || params.start === undefined) {
          return errContent("trim requires 'input', 'output', 'start'");
        }
        return runResponse(await trim(params as any));
      }
      if (a === "concat") {
        if (!params.input_paths || !params.output) return errContent("concat requires 'input_paths' and 'output'");
        return runResponse(await concat(params as any));
      }
      if (a === "extract_audio") {
        if (!params.input || !params.output) return errContent("extract_audio requires 'input' and 'output'");
        return runResponse(await extractAudio(params as any));
      }
      if (a === "thumbnail") {
        if (!params.input || !params.output) return errContent("thumbnail requires 'input' and 'output'");
        return runResponse(await thumbnail(params as any));
      }
      if (a === "run") {
        if (!params.args) return errContent("run requires 'args'");
        return runResponse(await run(params as any));
      }
      if (a === "version") {
        return textContent(await version());
      }
      return errContent(`unknown action: ${a}`);
    } catch (err: any) {
      return errContent(`Error: ${err?.message ?? String(err)}`);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
