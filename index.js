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

app.use("/output", (req, res, next) => {   res.setHeader("Access-Control-Allow-Origin", "*");   res.setHeader("Access-Control-Allow-Methods", "GET");   next(); }, express.static(path.join(__dirname, "output")));

const tempDir = path.join(__dirname, "temp");
const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// ============ JOB QUEUE ============
// Process one video at a time to prevent memory issues
const jobQueue = [];
const jobResults = {};
let isProcessing = false;

function addToQueue(job) {
  jobQueue.push(job);
  jobResults[job.jobId] = { status: "queued", position: jobQueue.length };
  processNextInQueue();
}

async function processNextInQueue() {
  if (isProcessing || jobQueue.length === 0) return;
  isProcessing = true;

  const job = jobQueue.shift();

  // Update positions for remaining jobs
  jobQueue.forEach((j, i) => {
    if (jobResults[j.jobId]) jobResults[j.jobId].position = i + 1;
  });

  try {
    jobResults[job.jobId] = { status: "processing" };
    const result = await job.execute();
    jobResults[job.jobId] = { status: "completed", ...result };
  } catch (error) {
    console.error(`[${job.jobId}] Error:`, error.message);
    jobResults[job.jobId] = { status: "failed", error: error.message };
  }

  // Clean up result after 1 hour
  setTimeout(() => {
    delete jobResults[job.jobId];
  }, 60 * 60 * 1000);

  isProcessing = false;
  processNextInQueue();
}

// ============ ENDPOINTS ============

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "FFmpeg Processing Server is running",
    queue_length: jobQueue.length,
    is_processing: isProcessing,
  });
});

// Check job status
app.get("/api/job-status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const result = jobResults[jobId];
  if (!result) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json({ job_id: jobId, ...result });
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

// Process video — now uses a queue
app.post("/api/process", async (req, res) => {
  const { video_url, audio_url } = req.body;

  if (!video_url || !audio_url) {
    return res.status(400).json({
      error: "Missing required fields: video_url and audio_url",
    });
  }

  const jobId = uuidv4();
  const baseUrl = getBaseUrl(req);

  // Add to queue and return immediately
  addToQueue({
    jobId,
    execute: async () => {
      const videoPath = path.join(tempDir, `${jobId}_video.mp4`);
      const audioPath = path.join(tempDir, `${jobId}_audio.mp3`);
      const finalPath = path.join(outputDir, `${jobId}_final.mp4`);

      try {
        console.log(`[${jobId}] Starting processing...`);

        console.log(`[${jobId}] Downloading video...`);
        await downloadFile(video_url, videoPath);
        console.log(`[${jobId}] Downloading audio...`);
        await downloadFile(audio_url, audioPath);

        console.log(`[${jobId}] Getting audio duration...`);
        const audioDuration = await getMediaDuration(audioPath);
        console.log(`[${jobId}] Audio duration: ${audioDuration} seconds`);

        console.log(`[${jobId}] Processing: slowing down video and merging with audio...`);
        await runFFmpeg(
          `-i "${videoPath}" -i "${audioPath}" -filter:v "setpts=2.0*PTS" -c:v libx264 -preset ultrafast -crf 28 -threads 2 -c:a aac -b:a 128k -map 0:v:0 -map 1:a:0 -t ${audioDuration} -movflags +faststart -y "${finalPath}"`
        );

        console.log(`[${jobId}] Processing complete!`);

        const finalUrl = `${baseUrl}/output/${jobId}_final.mp4`;

        cleanup([videoPath, audioPath]);

        setTimeout(() => {
          cleanup([finalPath]);
          console.log(`[${jobId}] Cleaned up output file`);
        }, 60 * 60 * 1000);

        return { final_video_url: finalUrl };
      } catch (error) {
        cleanup([videoPath, audioPath, finalPath]);
        throw error;
      }
    },
  });

  // Return immediately with job ID — client will poll for status
  res.json({
    success: true,
    job_id: jobId,
    status: "queued",
    position: jobQueue.length,
    message: "Job queued. Poll /api/job-status/" + jobId + " for updates.",
  });
});

// ============ HELPERS ============

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
    exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 600000 }, (error) => {
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
app.get("/api/download/:filename", (req, res) => {
  const { filename } = req.params;
  const downloadName = req.query.name || filename;
  const filePath = path.join(outputDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.sendFile(filePath);
});
app.listen(PORT, () => {
  console.log(`FFmpeg Processing Server running on port ${PORT}`);
});
