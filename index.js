const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use("/output", express.static(path.join(__dirname, "output")));

const tempDir = path.join(__dirname, "temp");
const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "FFmpeg Processing Server is running" });
});

// Speed up audio to 2x
app.post("/api/speed-audio", async (req, res) => {
  const { audio_url } = req.body;

  if (!audio_url) {
    return res.status(400).json({ error: "Missing required field: audio_url" });
  }

  const jobId = uuidv4();
  const audioPath = path.join(tempDir, `${jobId}_audio.mp3`);
  const speedPath = path.join(outputDir, `${jobId}_2x.mp3`);

  try {
    console.log(`[${jobId}] Speeding up audio...`);

    await downloadFile(audio_url, audioPath);

    // atempo=2.0 speeds up audio 2x WITHOUT changing pitch (no chipmunk effect)
    await runFFmpeg(
      `-i "${audioPath}" -filter:a "atempo=2.0" -c:a libmp3lame -b:a 128k -y "${speedPath}"`
    );

    console.log(`[${jobId}] Audio speed-up complete!`);

    const speedUrl = `${getBaseUrl(req)}/output/${jobId}_2x.mp3`;

    cleanup([audioPath]);

    setTimeout(() => {
      cleanup([speedPath]);
    }, 60 * 60 * 1000);

    res.json({ success: true, audio_2x_url: speedUrl });
  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    cleanup([audioPath, speedPath]);
    res.status(500).json({ error: "Speed-up failed", details: error.message });
  }
});

app.post("/api/process", async (req, res) => {
  const { video_url, audio_url } = req.body;

  if (!video_url || !audio_url) {
    return res.status(400).json({
      error: "Missing required fields: video_url and audio_url",
    });
  }

  const jobId = uuidv4();
  const videoPath = path.join(tempDir, `${jobId}_video.mp4`);
  const audioPath = path.join(tempDir, `${jobId}_audio.mp3`);
  const finalPath = path.join(outputDir, `${jobId}_final.mp4`);

  try {
    console.log(`[${jobId}] Starting processing...`);

    console.log(`[${jobId}] Downloading video...`);
    await downloadFile(video_url, videoPath);
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(audio_url, audioPath);

    // Step 1: Get the exact duration of the audio file (this is the leading duration)
    console.log(`[${jobId}] Getting audio duration...`);
    const audioDuration = await getMediaDuration(audioPath);
    console.log(`[${jobId}] Audio duration: ${audioDuration} seconds`);

    // Step 2: Slow down video + merge with audio
    // Use -t to cut the final output to exactly the audio duration
    // This ensures the final video is EXACTLY the same length as the 1x voiceover
    console.log(`[${jobId}] Processing: slowing down video and merging with audio...`);
    await runFFmpeg(
      `-i "${videoPath}" -i "${audioPath}" -filter:v "setpts=2.0*PTS" -c:v libx264 -preset ultrafast -crf 28 -threads 2 -c:a aac -b:a 128k -map 0:v:0 -map 1:a:0 -t ${audioDuration} -movflags +faststart -y "${finalPath}"`
    );

    console.log(`[${jobId}] Processing complete!`);

    const finalUrl = `${getBaseUrl(req)}/output/${jobId}_final.mp4`;

    cleanup([videoPath, audioPath]);

    setTimeout(() => {
      cleanup([finalPath]);
      console.log(`[${jobId}] Cleaned up output file`);
    }, 60 * 60 * 1000);

    res.json({
      success: true,
      job_id: jobId,
      final_video_url: finalUrl,
    });
  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    cleanup([videoPath, audioPath, finalPath]);
    res.status(500).json({
      error: "Processing failed",
      details: error.message,
    });
  }
});

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    exec(
      `curl -L -o "${destination}" "${url}"`,
      { maxBuffer: 1024 * 1024 * 10 },
      (error) => {
        if (error) {
          reject(new Error(`Download failed: ${error.message}`));
        } else if (!fs.existsSync(destination)) {
          reject(new Error(`Download failed: file not created`));
        } else {
          const size = fs.statSync(destination).size;
          if (size === 0) {
            reject(new Error(`Download failed: empty file`));
          } else {
            console.log(`Downloaded ${(size / 1024 / 1024).toFixed(2)} MB`);
            resolve();
          }
        }
      }
    );
  });
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      (error, stdout) => {
        if (error) {
          reject(new Error(`ffprobe error: ${error.message}`));
        } else {
          const duration = parseFloat(stdout.trim());
          if (isNaN(duration)) {
            reject(new Error(`Could not parse duration from: ${stdout}`));
          } else {
            resolve(duration);
          }
        }
      }
    );
  });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg ${args}`;
    console.log(`Running: ${cmd}`);
    exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 300000 }, (error) => {
      if (error) {
        reject(new Error(`FFmpeg error: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
}

function cleanup(files) {
  files.forEach((file) => {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {}
  });
}

function getBaseUrl(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `${req.protocol}://${req.get("host")}`;
}

app.listen(PORT, () => {
  console.log(`FFmpeg Processing Server running on port ${PORT}`);
});
