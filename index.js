const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your Lovable app
app.use(cors());
app.use(express.json());

// Serve processed files temporarily
app.use("/output", express.static(path.join(__dirname, "output")));

// Create directories
const tempDir = path.join(__dirname, "temp");
const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "FFmpeg Processing Server is running" });
});

// Main processing endpoint
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
  const slowedVideoPath = path.join(tempDir, `${jobId}_slowed.mp4`);
  const finalPath = path.join(outputDir, `${jobId}_final.mp4`);

  try {
    console.log(`[${jobId}] Starting processing...`);
    console.log(`[${jobId}] Video URL: ${video_url}`);
    console.log(`[${jobId}] Audio URL: ${audio_url}`);

    // Step 1: Download the video
    console.log(`[${jobId}] Downloading video...`);
    await downloadFile(video_url, videoPath);

    // Step 2: Download the audio
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(audio_url, audioPath);

    // Step 3: Slow down the video by 50% (make it 2x longer)
    console.log(`[${jobId}] Slowing down video by 50%...`);
    await runFFmpeg(
      `-i "${videoPath}" -filter:v "setpts=2.0*PTS" -an "${slowedVideoPath}"`
    );

    // Step 4: Merge slowed video with original 1x audio
    console.log(`[${jobId}] Merging video with audio...`);
    await runFFmpeg(
      `-i "${slowedVideoPath}" -i "${audioPath}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${finalPath}"`
    );

    console.log(`[${jobId}] Processing complete!`);

    // Return the URL to the final video
    const finalUrl = `${getBaseUrl(req)}/output/${jobId}_final.mp4`;

    // Clean up temp files (keep the final output)
    cleanup([videoPath, audioPath, slowedVideoPath]);

    // Schedule cleanup of output file after 1 hour
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

    // Clean up all files on error
    cleanup([videoPath, audioPath, slowedVideoPath, finalPath]);

    res.status(500).json({
      error: "Processing failed",
      details: error.message,
    });
  }
});

// Download a file from a URL
function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    exec(
      `curl -L -o "${destination}" "${url}"`,
      { maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Download failed: ${error.message}`));
        } else if (!fs.existsSync(destination)) {
          reject(new Error(`Download failed: file not created`));
        } else {
          const size = fs.statSync(destination).size;
          if (size === 0) {
            reject(new Error(`Download failed: empty file`));
          } else {
            console.log(
              `Downloaded ${(size / 1024 / 1024).toFixed(2)} MB to ${destination}`
            );
            resolve();
          }
        }
      }
    );
  });
}

// Run an FFmpeg command
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg ${args}`;
    console.log(`Running: ${cmd}`);
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`FFmpeg error: ${error.message}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Clean up temporary files
function cleanup(files) {
  files.forEach((file) => {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      console.warn(`Cleanup failed for ${file}: ${e.message}`);
    }
  });
}

// Get the base URL for building download links
function getBaseUrl(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `${req.protocol}://${req.get("host")}`;
}

app.listen(PORT, () => {
  console.log(`FFmpeg Processing Server running on port ${PORT}`);
});
