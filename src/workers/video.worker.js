const { Worker } = require('bullmq');
require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { redisConnection } = require('../config/queue');
const db = require('../config/db');
const r2 = require('../config/r2');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const updateStatus = async (jobId, data) => {
  const vercelUrl = process.env.VERCEL_URL || 'http://localhost:3000'; // Fallback for local testing
  const apiEndpoint = `${vercelUrl}/api/v1/video/jobs/${jobId}/status`;

  // 1. Update local DB (if running in same environment as API)
  try {
    const { status, frames, startedAt, completedAt, failedAt, error } = data;
    let query = 'UPDATE jobs SET status = ?';
    const params = [status];

    if (frames) {
      query += ', frames = ?';
      params.push(JSON.stringify(frames));
    }
    if (startedAt) {
      query += ', startedAt = ?';
      params.push(startedAt);
    }
    if (completedAt) {
      query += ', completedAt = ?';
      params.push(completedAt);
    }
    if (failedAt) {
      query += ', failedAt = ?';
      params.push(failedAt);
    }
    if (error) {
      query += ', error = ?';
      params.push(error);
    }

    query += ' WHERE jobId = ?';
    params.push(jobId);

    db.prepare(query).run(...params);
    console.log(`Local DB updated for job ${jobId}`);
  } catch (err) {
    // Silently fail local DB update if it's not present (common when running worker remotely)
    // console.log(`Local DB update skipped for job ${jobId}`);
  }

  // 2. Update Vercel API (Crucial for remote workers)
  try {
    await axios.post(apiEndpoint, data);
    console.log(`Vercel API updated for job ${jobId}`);
  } catch (err) {
    console.error(`Failed to update Vercel API for job ${jobId}:`, err.message);
  }
};

const worker = new Worker('video-processing', async (job) => {
  console.log(`🔔 [Worker] Received job: ${job.id}`);
  const { jobId, videoUrl, fps, webhookUrl } = job.data;
  const outputDir = path.join(os.tmpdir(), 'videotoimage', jobId);

  // Initial check via API/Local DB
  const vercelUrl = process.env.VERCEL_URL || 'http://localhost:3000';
  try {
    const res = await axios.get(`${vercelUrl}/api/v1/video/jobs/${jobId}`);
    if (!res.data) return console.log(`Job ${jobId} not found. Stopping.`);
  } catch (err) {
    // If API check fails, fallback to local DB check
    const initialJobCheck = db.prepare('SELECT jobId FROM jobs WHERE jobId = ?').get(jobId);
    if (!initialJobCheck) {
      return console.log(`Job ${jobId} was cancelled before processing could start.`);
    }
  }

  console.log(`Starting job ${jobId} for video: ${videoUrl}`);

  // Update job status to 'processing'
  await updateStatus(jobId, { status: 'processing', startedAt: new Date().toISOString() });

  const localVideoPath = path.join(os.tmpdir(), `video_${jobId}.mp4`);

  try {
    // Check cancellation again before downloading
    try {
      await axios.get(`${vercelUrl}/api/v1/video/jobs/${jobId}`);
    } catch (err) {
      console.log(`Job ${jobId} was cancelled before download. Stopping.`);
      return;
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 0. Download video locally to avoid FFmpeg SIGSEGV on streaming
    console.log(`Downloading video locally for job ${jobId}...`);
    const writer = fs.createWriteStream(localVideoPath);
    const response = await axios({
      url: videoUrl,
      method: 'GET',
      responseType: 'stream'
    });

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', (err) => {
        writer.close();
        reject(err);
      });
    });
    console.log(`Video downloaded to ${localVideoPath}`);

    // Check cancellation again after download
    try {
      await axios.get(`${vercelUrl}/api/v1/video/jobs/${jobId}`);
    } catch (err) {
      console.log(`Job ${jobId} was cancelled after download. Stopping.`);
      if (fs.existsSync(localVideoPath)) fs.unlinkSync(localVideoPath);
      return;
    }

    // 1. Extract frames locally
    await new Promise((resolve, reject) => {
      let command = ffmpeg(localVideoPath)
        .on('start', (cmd) => console.log('FFmpeg started with cmd:', cmd))
        .on('end', () => {
          console.log('FFmpeg finished extraction.');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        });

      if (fps) {
        command.outputOptions(`-vf fps=${fps}`);
      }

      command.output(path.join(outputDir, 'frame_%04d.png')).run();
    });

    // 2. Upload frames to Cloudflare R2 and update status incrementally
    const frameFiles = fs.readdirSync(outputDir);
    console.log(`Found ${frameFiles.length} frames to upload.`);

    const uploadedUrls = [];

    for (const file of frameFiles) {
      // Check cancellation via API/Local DB during the loop
      try {
        await axios.get(`${vercelUrl}/api/v1/video/jobs/${jobId}`);
      } catch (err) {
        console.log(`Job ${jobId} was cancelled during frame upload. Stopping.`);
        if (fs.existsSync(outputDir)) {
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
        return;
      }

      const filePath = path.join(outputDir, file);
      const fileContent = fs.readFileSync(filePath);
      const r2Key = `temp/${jobId}/${file}`; // Upload to temp folder

      const uploadParams = {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: r2Key,
        Body: fileContent,
        ContentType: 'image/png',
      };

      await r2.send(new PutObjectCommand(uploadParams));
      const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;
      uploadedUrls.push(publicUrl);

      // Update status after each upload
      await updateStatus(jobId, { status: 'processing', frames: uploadedUrls });
      console.log(`Uploaded and updated status for frame: ${file}`);
    }

    // 3. Update job status to 'previewing' (User must now select frames to save)
    await updateStatus(jobId, { status: 'previewing', completedAt: new Date().toISOString(), frames: uploadedUrls });
    
    console.log(`Job ${jobId} is ready for preview.`);

    // 4. Notify via Webhook
    if (webhookUrl) {
      try {
        const framesList = uploadedUrls.map((url, index) => `${index + 1}. ${url}`).join('\n');
        await axios.post(webhookUrl, {
          text: `✅ *Process Done!*\n*Job ID:* ${jobId}\n*Status:* Completed\n*Total Frames:* ${uploadedUrls.length}\n\n*Frames List:*\n${framesList}`,
          message: "Process Done",
          jobId,
          status: 'completed',
          frames: uploadedUrls
        });
        console.log(`Webhook notification sent for job ${jobId}`);
      } catch (webhookErr) {
        console.error(`Failed to notify webhook for job ${jobId}:`, webhookErr.message);
      }
    }

    // 5. Clean up local files (frames and original video)
    try {
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      if (fs.existsSync(localVideoPath)) {
        fs.unlinkSync(localVideoPath);
      }
      console.log(`Local temporary files for job ${jobId} deleted.`);
    } catch (cleanupErr) {
      console.error(`Failed to cleanup local files for job ${jobId}:`, cleanupErr);
    }

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    
    // Cleanup on error
    try {
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      if (fs.existsSync(localVideoPath)) {
        fs.unlinkSync(localVideoPath);
      }
    } catch (cleanupErr) {
      console.error(`Failed to cleanup local files after error for job ${jobId}:`, cleanupErr);
    }

    await updateStatus(jobId, { status: 'failed', failedAt: new Date().toISOString(), error: error.message });

    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          message: "Process Failed",
          jobId,
          status: 'failed',
          error: error.message
        });
      } catch (webhookErr) {
        console.error(`Failed to notify webhook for failed job ${jobId}:`, webhookErr.message);
      }
    }
  }
}, { connection: redisConnection });

worker.on('error', err => {
  console.error('❌ Worker Redis Connection Error:', err.message);
});

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

worker.on('failed', (job, err) => {
  console.log(`Job ${job.id} failed with error: ${err.message}`);
});

module.exports = worker;
