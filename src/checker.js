const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const config = require("./json/config.json");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function ask(q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function selectFile() {
  const supportedExts = config.supportedExtensions;

  const rootDir = "./";
  const files = fs.readdirSync(rootDir).filter((file) => {
    const ext = path.extname(file).toLowerCase();
    return supportedExts.includes(ext);
  });

  if (files.length === 0) {
    console.log("\nルートディレクトリに対象ファイルが見つかりません。");
    const manualPath = await ask(
      "ファイルまたはフォルダのパスを直接入力してください:\n> ",
    );
    const trimmedPath = manualPath.trim().replace(/^['"](.*)['"]$/, "$1");
    if (trimmedPath && fs.existsSync(trimmedPath)) return trimmedPath;
    return await selectFile();
  }

  console.log("\n解析するファイルを選択してください:");
  files.forEach((file, index) => {
    console.log(`[${index + 1}] ${file}`);
  });

  const rawInput = await ask("> ");
  const input = rawInput.trim();

  if (input === "") return await selectFile();

  const choice = parseInt(input, 10);
  const selected = files[choice - 1];

  if (selected) {
    return selected;
  } else {
    console.log("無効な選択です。");
    return await selectFile();
  }
}

async function getFileInfo(inputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        inputPath,
      ],
      { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout) => {
        if (err) return reject("ffprobe エラー: " + err);
        resolve(JSON.parse(stdout));
      },
    );
  });
}

async function checkLUFS(inputPath, targetLUFS = -14) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-i",
        inputPath,
        "-af",
        `loudnorm=I=${targetLUFS}:print_format=json`,
        "-f",
        "null",
        "-",
      ],
      { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        const output = stderr || stdout;
        const jsonMatch = output.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) return reject("loudnorm の解析に失敗しました");
        resolve(JSON.parse(jsonMatch[0]));
      },
    );
  });
}

(async () => {
  try {
    const input = await selectFile();
    console.log(`\n--- 「${input}」を詳細解析中 ---`);

    const [loudness, info] = await Promise.all([
      checkLUFS(input),
      getFileInfo(input),
    ]);

    const format = info.format;
    const audioStream =
      info.streams.find((s) => s.codec_type === "audio") || info.streams[0];
    const videoStream = info.streams.find((s) => s.codec_type === "video");

    console.log("\n" + "=".repeat(40));
    console.log("基本情報");
    console.log("-".repeat(40));
    console.log(`ファイル名: ${path.basename(input)}`);
    console.log(`フォーマット: ${format.format_long_name}`);
    console.log(`再生時間: ${parseFloat(format.duration).toFixed(2)} 秒`);
    console.log(`サイズ: ${(format.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log(
      `全体のビットレート: ${Math.round(format.bit_rate / 1000)} kbps`,
    );

    console.log("\nオーディオ詳細");
    console.log("-".repeat(40));
    console.log(
      `コーデック: ${audioStream.codec_name} (${audioStream.codec_long_name})`,
    );
    console.log(`サンプリングレート: ${audioStream.sample_rate} Hz`);
    console.log(
      `チャンネル数: ${audioStream.channels} (${audioStream.channel_layout || "N/A"})`,
    );
    if (audioStream.bit_rate)
      console.log(
        `ビットレート: ${Math.round(audioStream.bit_rate / 1000)} kbps`,
      );

    if (videoStream) {
      console.log("\nビデオ詳細");
      console.log("-".repeat(40));
      console.log(`コーデック: ${videoStream.codec_name}`);
      console.log(`解像度: ${videoStream.width}x${videoStream.height}`);
      console.log(`フレームレート: ${videoStream.r_frame_rate} fps`);
    }

    console.log("\nラウドネス測定 (EBU R128)");
    console.log("-".repeat(40));
    console.log(`Integrated (I):   ${loudness.input_i} LUFS`);
    console.log(`True Peak (TP):   ${loudness.input_tp} dBTP`);
    console.log(`Loudness Range:   ${loudness.input_lra} LU`);
    console.log(`Threshold:        ${loudness.input_thresh} LUFS`);
    console.log(`Target Offset:    ${loudness.target_offset} LU`);
    console.log("=".repeat(40));
  } catch (err) {
    console.error("\nエラー:", err);
  } finally {
    rl.close();
  }
})();
