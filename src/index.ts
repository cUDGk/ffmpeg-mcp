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

async function watermark(p: {
  input: string;
  watermark: string;
  output: string;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  margin?: number;
  scale?: number;
  opacity?: number;
  overwrite?: boolean;
  timeout?: number;
}) {
  const pos = p.position ?? "bottom-right";
  const m = p.margin ?? 20;
  const overlayXY: Record<string, string> = {
    "top-left": `${m}:${m}`,
    "top-right": `main_w-overlay_w-${m}:${m}`,
    "bottom-left": `${m}:main_h-overlay_h-${m}`,
    "bottom-right": `main_w-overlay_w-${m}:main_h-overlay_h-${m}`,
    "center": `(main_w-overlay_w)/2:(main_h-overlay_h)/2`,
  };
  const scale = p.scale ?? 0.15;
  const opacity = p.opacity ?? 1.0;
  const wmFilter = [
    `scale=iw*${scale}:-1`,
    opacity < 1 ? `format=rgba,colorchannelmixer=aa=${opacity}` : null,
  ].filter(Boolean).join(",");
  const filterComplex = `[1:v]${wmFilter}[wm];[0:v][wm]overlay=${overlayXY[pos]}`;
  const args: string[] = [];
  args.push(p.overwrite === false ? "-n" : "-y");
  args.push("-i", resolve(p.input));
  args.push("-i", resolve(p.watermark));
  args.push("-filter_complex", filterComplex);
  args.push("-map", "0:a?", "-c:a", "copy");
  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "22");
  args.push(resolve(p.output));
  return runCmd(FFMPEG, args, { timeout: p.timeout });
}

async function loudnormPass1(input: string): Promise<{
  input_i: number; input_tp: number; input_lra: number;
  input_thresh: number; target_offset: number;
}> {
  const args = [
    "-hide_banner", "-nostats",
    "-i", resolve(input),
    "-af", "loudnorm=print_format=json",
    "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null",
  ];
  const r = await runCmd(FFMPEG, args);
  // loudnorm prints the JSON block at the END of stderr
  const match = r.stderr.match(/\{[\s\S]*?"target_offset"\s*:[\s\S]*?\}/);
  if (!match) throw new Error(`loudnorm pass 1 failed to print JSON block. stderr tail:\n${r.stderr.slice(-2000)}`);
  const j = JSON.parse(match[0]);
  return {
    input_i: parseFloat(j.input_i),
    input_tp: parseFloat(j.input_tp),
    input_lra: parseFloat(j.input_lra),
    input_thresh: parseFloat(j.input_thresh),
    target_offset: parseFloat(j.target_offset),
  };
}

async function loudnorm(p: {
  input: string; output: string;
  target_i?: number;
  target_tp?: number;
  target_lra?: number;
  audio_codec?: string;
  audio_bitrate?: string;
  overwrite?: boolean;
  timeout?: number;
}) {
  const targetI = p.target_i ?? -16;
  const targetTP = p.target_tp ?? -1.5;
  const targetLRA = p.target_lra ?? 11;
  const measured = await loudnormPass1(p.input);
  const args: string[] = [];
  args.push(p.overwrite === false ? "-n" : "-y");
  args.push("-i", resolve(p.input));
  const af = [
    `loudnorm=I=${targetI}:TP=${targetTP}:LRA=${targetLRA}`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    `linear=true:print_format=summary`,
  ].join(":");
  args.push("-af", af);
  args.push("-c:a", p.audio_codec ?? "aac");
  if (p.audio_bitrate) args.push("-b:a", p.audio_bitrate);
  args.push("-ar", "48000");
  args.push(resolve(p.output));
  const r = await runCmd(FFMPEG, args, { timeout: p.timeout });
  return { ...r, measured, target: { I: targetI, TP: targetTP, LRA: targetLRA } };
}

function buildAtempoChain(speed: number): string {
  const filters: string[] = [];
  let s = speed;
  while (s > 2.0) { filters.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5) { filters.push("atempo=0.5"); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) filters.push(`atempo=${s}`);
  return filters.length ? filters.join(",") : "anull";
}

async function changeSpeed(p: {
  input: string; output: string;
  speed: number;
  video_only?: boolean;
  audio_only?: boolean;
  overwrite?: boolean;
  timeout?: number;
}) {
  if (p.speed <= 0) throw new Error("speed must be > 0");
  const args: string[] = [];
  args.push(p.overwrite === false ? "-n" : "-y");
  args.push("-i", resolve(p.input));
  if (!p.audio_only) {
    args.push("-filter:v", `setpts=${(1 / p.speed).toFixed(6)}*PTS`);
  } else {
    args.push("-c:v", "copy");
  }
  if (!p.video_only) {
    args.push("-filter:a", buildAtempoChain(p.speed));
  } else {
    args.push("-an");
  }
  args.push(resolve(p.output));
  return runCmd(FFMPEG, args, { timeout: p.timeout });
}

type BatchJob = {
  action: "convert" | "trim" | "extract_audio" | "thumbnail" | "watermark" | "loudnorm" | "speed" | "run";
  [k: string]: any;
};

async function batch(p: { jobs: BatchJob[]; stop_on_error?: boolean }) {
  const results: any[] = [];
  for (const [i, job] of p.jobs.entries()) {
    try {
      let r: any;
      switch (job.action) {
        case "convert": r = await convert(job as any); break;
        case "trim": r = await trim(job as any); break;
        case "extract_audio": r = await extractAudio(job as any); break;
        case "thumbnail": r = await thumbnail(job as any); break;
        case "watermark": r = await watermark(job as any); break;
        case "loudnorm": r = await loudnorm(job as any); break;
        case "speed": r = await changeSpeed(job as any); break;
        case "run": r = await run(job as any); break;
        default: throw new Error(`unknown batch action: ${job.action}`);
      }
      const ok = (r as any).exit_code === 0;
      results.push({ index: i, action: job.action, ok, exit_code: (r as any).exit_code, duration_ms: (r as any).duration_ms, stderr: ((r as any).stderr ?? "").slice(-800) });
      if (!ok && p.stop_on_error) break;
    } catch (err: any) {
      results.push({ index: i, action: job.action, ok: false, error: err?.message ?? String(err) });
      if (p.stop_on_error) break;
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    total: p.jobs.length,
    processed: results.length,
    succeeded: okCount,
    failed: results.length - okCount,
    results,
  };
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
      "watermark", "loudnorm", "speed", "batch",
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
    watermark_path: z.string().optional().describe("watermark: overlay image path"),
    position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"]).optional().describe("watermark: placement"),
    margin: z.number().optional().describe("watermark: pixels from edge (default 20)"),
    watermark_scale: z.number().positive().optional().describe("watermark: relative size vs. main video width (default 0.15 = 15%)"),
    opacity: z.number().min(0).max(1).optional().describe("watermark: alpha 0..1 (default 1)"),
    target_i: z.number().optional().describe("loudnorm: target integrated LUFS (default -16)"),
    target_tp: z.number().optional().describe("loudnorm: target true peak dBFS (default -1.5)"),
    target_lra: z.number().optional().describe("loudnorm: target loudness range (default 11)"),
    speed_factor: z.number().positive().optional().describe("speed: playback speed multiplier (>0, e.g. 2 = 2x)"),
    video_only: z.boolean().optional().describe("speed: only apply to video (mute audio)"),
    audio_only: z.boolean().optional().describe("speed: only apply to audio (copy video)"),
    jobs: z.array(z.object({ action: z.string() }).passthrough()).optional().describe("batch: list of job specs {action: ..., ...args}"),
    stop_on_error: z.boolean().optional().describe("batch: abort after first failure"),
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
      if (a === "watermark") {
        if (!params.input || !params.output || !params.watermark_path) return errContent("watermark requires 'input', 'output', 'watermark_path'");
        return runResponse(await watermark({
          input: params.input, output: params.output,
          watermark: params.watermark_path,
          position: params.position, margin: params.margin,
          scale: params.watermark_scale,
          opacity: params.opacity,
          overwrite: params.overwrite, timeout: params.timeout,
        }));
      }
      if (a === "loudnorm") {
        if (!params.input || !params.output) return errContent("loudnorm requires 'input' and 'output'");
        const r = await loudnorm({
          input: params.input, output: params.output,
          target_i: params.target_i, target_tp: params.target_tp, target_lra: params.target_lra,
          audio_codec: params.audio_codec, audio_bitrate: params.audio_bitrate,
          overwrite: params.overwrite, timeout: params.timeout,
        });
        const res = textContent(r);
        if ((r as any).exit_code !== 0) (res as any).isError = true;
        return res;
      }
      if (a === "speed") {
        if (!params.input || !params.output || params.speed_factor === undefined) return errContent("speed requires 'input', 'output', 'speed_factor'");
        return runResponse(await changeSpeed({
          input: params.input, output: params.output,
          speed: params.speed_factor,
          video_only: params.video_only, audio_only: params.audio_only,
          overwrite: params.overwrite, timeout: params.timeout,
        }));
      }
      if (a === "batch") {
        if (!params.jobs || params.jobs.length === 0) return errContent("batch requires 'jobs' (non-empty)");
        return textContent(await batch({ jobs: params.jobs as any, stop_on_error: params.stop_on_error }));
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
