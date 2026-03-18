const { Worker } = require('bullmq');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { redisConnection } = require('../config/queue');
const db = require('../config/db');
const r2 = require('../config/r2');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegStatic);

const worker = new Worker('video-processing', async (job) => {
  const { jobId, videoUrl, fps, webhookUrl } = job.data;
  // Use system temp directory instead of project directory
  const outputDir = path.join(os.tmpdir(), 'videotoimage', jobId);

  // Initial check: If job is already cancelled, don't start
  const initialJobCheck = db.prepare('SELECT jobId FROM jobs WHERE jobId = ?').get(jobId);
  if (!initialJobCheck) {
    return console.log(`Job ${jobId} was cancelled before processing could start.`);
  }

  console.log(`Starting job ${jobId} for video: ${videoUrl}`);

  // Update job status to 'processing' in DB
  try {
    const updateStmt = db.prepare('UPDATE jobs SET status = ?, startedAt = ? WHERE jobId = ?');
    updateStmt.run('processing', new Date().toISOString(), jobId);
  } catch (err) {
    console.error(`Failed to update status to processing for job ${jobId}:`, err);
  }

  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 1. Extract frames locally
    await new Promise((resolve, reject) => {
      let command = ffmpeg(videoUrl)
        .on('start', (cmd) => console.log('FFmpeg started with cmd:', cmd))
        .on('end', () => {
          console.log('FFmpeg finished extraction.');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        });

      // If fps is provided, use it. Otherwise, extract ALL frames.
      if (fps) {
        command.outputOptions(`-vf fps=${fps}`);
      }

      command.output(path.join(outputDir, 'frame_%04d.png')).run();
    });

    // 2. Upload frames to Cloudflare R2 and update DB incrementally
    const frameFiles = fs.readdirSync(outputDir);
    console.log(`Found ${frameFiles.length} frames to upload.`);

    const uploadedUrls = [];
    const updateStmt = db.prepare('UPDATE jobs SET frames = ? WHERE jobId = ?');

    for (const file of frameFiles) {
      // Check if job was cancelled during the loop
      const loopJobCheck = db.prepare('SELECT jobId FROM jobs WHERE jobId = ?').get(jobId);
      if (!loopJobCheck) {
        console.log(`Job ${jobId} was cancelled during frame upload. Stopping.`);
        // Clean up partially created temp files
        if (fs.existsSync(outputDir)) {
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
        return; // Exit the worker process
      }

      const filePath = path.join(outputDir, file);
      const fileContent = fs.readFileSync(filePath);
      const r2Key = `frames/${jobId}/${file}`;

      const uploadParams = {
        Bucket: process.env.R2_BUCKET_NAME,
        Key: r2Key,
        Body: fileContent,
        ContentType: 'image/png',
      };

      await r2.send(new PutObjectCommand(uploadParams));
      const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;
      uploadedUrls.push(publicUrl);

      // Update database after each upload so frontend can show it "live"
      updateStmt.run(JSON.stringify(uploadedUrls), jobId);
      console.log(`Uploaded and updated DB for frame: ${file}`);
    }

    // 3. Update job status to 'completed' in DB
    const completeStmt = db.prepare('UPDATE jobs SET status = ?, completedAt = ? WHERE jobId = ?');
    completeStmt.run('completed', new Date().toISOString(), jobId);
    
    console.log(`Job ${jobId} completed successfully.`);

    // 4. Notify via Webhook if provided (Simplified Notification)
    if (webhookUrl) {
      try {
        // Create a readable list of all frame URLs for Slack
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

    // 5. Clean up local frames after successful upload
    try {
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      console.log(`Local temporary frames for job ${jobId} deleted.`);
    } catch (cleanupErr) {
      console.error(`Failed to cleanup local files for job ${jobId}:`, cleanupErr);
    }

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    // Update job status to 'failed' in DB
    try {
        const failStmt = db.prepare('UPDATE jobs SET status = ?, failedAt = ?, error = ? WHERE jobId = ?');
        failStmt.run('failed', new Date().toISOString(), error.message, jobId);

        // Notify via Webhook about failure if provided
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
    } catch (dbErr) {
        console.error('Failed to update DB with error status:', dbErr);
    }
  }
}, { connection: redisConnection });

worker.on('failed', (job, err) => {
  console.log(`Job ${job.id} failed with error: ${err.message}`);
});

module.exports = worker;
