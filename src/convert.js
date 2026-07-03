const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
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
    console.log("\n対象ファイルが見つかりません。");
    const manualPath = await ask("パスを直接入力: ");
    const trimmed = manualPath.trim().replace(/^['"](.*)['"]$/, "$1");
    if (trimmed && fs.existsSync(trimmed)) return trimmed;
    return await selectFile();
  }

  console.log("\n変換するファイルを選択:");
  files.forEach((f, i) => console.log(`[${i + 1}] ${f}`));

  const rawInput = await ask("> ");
  const input = rawInput.trim();
  if (input === "") return await selectFile();

  const choice = parseInt(input, 10);
  const selected = files[choice - 1];

  if (selected) return selected;
  return await selectFile();
}

async function measureLoudness(inputPath, targetLUFS = -14) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${inputPath}" -af loudnorm=I=${targetLUFS}:print_format=json -f null - 2>&1`;
    exec(cmd, (err, stdout) => {
      const match = stdout.match(/\{[\s\S]*?\}/);
      if (!match) return reject("測定データの取得に失敗しました");
      resolve(JSON.parse(match[0]));
    });
  });
}

async function convert(
  inputPath,
  outputName,
  targetLUFS,
  targetTP,
  data,
  opts,
) {
  const outputPath = path.join("./", outputName);
  const filter = `loudnorm=I=${targetLUFS}:TP=${targetTP}:LRA=11:measured_I=${data.input_i}:measured_TP=${data.input_tp}:measured_LRA=${data.input_lra}:measured_thresh=${data.input_thresh}:offset=${data.target_offset}:linear=true`;

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath).audioFilters(filter);
    const out = ["-y"];

    if (opts.outputType === 1) {
      const videoCodecMap = {
        1: "libx264",
        2: "libx265",
        3: "prores_ks",
        4: "libvpx-vp9",
      };
      const videoCodec = videoCodecMap[opts.videoCodec];
      out.push(`-c:v ${videoCodec}`, `-preset ${opts.videoPreset}`);

      if (opts.videoMethod === 1) {
        out.push(`-crf ${opts.crf}`);
      } else {
        out.push(`-b:v ${opts.videoBitrate}`);
      }
      if (videoCodec === "prores_ks") out.push("-profile:v 3");
      if (
        videoCodec === "libx265" &&
        (outputName.endsWith(".mp4") || outputName.endsWith(".mov"))
      ) {
        out.push("-tag:v hvc1");
      }
    }

    const audioCodecMap = {
      1: "aac",
      2: "libopus",
      3: "libmp3lame",
      4: "pcm_s16le",
      5: "flac",
    };
    const audioCodec = audioCodecMap[opts.audioCodec];

    // Opus強制48k
    let finalSampleRate = opts.sampleRate;
    if (opts.audioCodec === 2) finalSampleRate = 48000;

    out.push(
      `-c:a ${audioCodec}`,
      `-ar ${finalSampleRate}`,
      `-ac ${opts.channels}`,
    );

    if (!["pcm_s16le", "flac"].includes(audioCodec)) {
      out.push(`-b:a ${opts.audioBitrate}`);
    }

    if (opts.outputType === 2) out.push("-vn");

    if (outputName.endsWith(".mp4") || outputName.endsWith(".mov")) {
      out.push("-movflags +faststart");
    }

    command
      .outputOptions(out)
      .on("start", (cmd) => console.log("\n実行コマンド:", cmd))
      .on("progress", (progress) => {
        process.stdout.write(
          `\r処理中: ${progress.percent ? progress.percent.toFixed(1) : 0}%... `,
        );
      })
      .on("end", () => {
        console.log("\n\n変換完了:", outputPath);
        resolve(outputPath);
      })
      .on("error", (err) => {
        console.error("\nエラー:", err.message);
        reject(err);
      })
      .save(outputPath);
  });
}

(async () => {
  try {
    const input = await selectFile();
    const targetLUFS = -14;
    console.log(`\n「${input}」を測定中...`);
    const data = await measureLoudness(input, targetLUFS);

    console.log("\n--- 出力設定 ---");
    console.log("[1] 映像ファイル\n[2] 音声ファイル");
    const outputType = parseInt(await ask("> "), 10);

    console.log("\n拡張子を選択:");
    const extMap =
      outputType === 1
        ? { 1: "mp4", 2: "mov", 3: "webm", 4: "mkv" }
        : { 1: "wav", 2: "mp3", 3: "flac", 4: "aac", 5: "opus" };
    Object.entries(extMap).forEach(([k, v]) => console.log(`[${k}] ${v}`));
    const ext = extMap[parseInt(await ask("> "), 10)];

    const outputName = `${path.parse(input).name}_processed.${ext}`;
    const targetTP = parseFloat(
      await ask(`測定LUFS: ${data.input_i}\nTrue Peak (TP) 目標値\n> `),
    );

    let vCodec, vPreset, vMethod, crf, vBitrate;
    if (outputType === 1) {
      console.log("\n映像コーデック:\n[1] H.264\n[2] H.265\n[3] ProRes\n[4] VP9");
      vCodec = parseInt(await ask("> "), 10);
      console.log(
        "\nプリセット:\n[1] ultrafast\n[2] fast\n[3] medium\n[4] slow\n[5] veryslow",
      );
      vPreset = {
        1: "ultrafast",
        2: "fast",
        3: "medium",
        4: "slow",
        5: "veryslow",
      }[parseInt(await ask("> "), 10)];
      console.log("\n品質方式:\n[1] CRF\n[2] Bitrate");
      vMethod = parseInt(await ask("> "), 10);
      if (vMethod === 1) crf = await ask("CRF値 (18-23推奨) > ");
      else vBitrate = await ask("動画ビットレート (例: 5M) > ");
    }

    console.log("\n音声コーデック:\n[1] AAC\n[2] Opus\n[3] MP3\n[4] PCM\n[5] FLAC");
    const aCodec = parseInt(await ask("> "), 10);
    console.log("\n音声ビットレート:\n[1] 128k\n[2] 192k\n[3] 256k\n[4] 320k");
    const aBitrate = { 1: "128k", 2: "192k", 3: "256k", 4: "320k" }[
      parseInt(await ask("> "), 10)
    ];
    console.log("\nサンプルレート:\n[1] 44100\n[2] 48000\n[3] 96000");
    const sRate = { 1: 44100, 2: 48000, 3: 96000 }[
      parseInt(await ask("> "), 10)
    ];
    console.log("\nチャンネル:\n[1] Mono\n[2] Stereo");
    const ch = { 1: 1, 2: 2 }[parseInt(await ask("> "), 10)];

    rl.close();

    await convert(input, outputName, targetLUFS, targetTP, data, {
      outputType,
      videoCodec: vCodec,
      videoPreset: vPreset,
      videoMethod: vMethod,
      crf,
      videoBitrate: vBitrate,
      audioCodec: aCodec,
      audioBitrate: aBitrate,
      sampleRate: sRate,
      channels: ch,
    });
  } catch (err) {
    console.error(err);
    rl.close();
  }
})();
