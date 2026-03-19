const { Worker } = require('bullmq');
require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { redisUrl, connectionOptions } = require('../config/redis');
const db = require('../config/db');
const r2 = require('../config/r2');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const updateStatus = async (jobId, data) => {
  const port = process.env.PORT || 3000;
  const apiUrl = process.env.RENDER_EXTERNAL_URL || process.env.VERCEL_URL || `http://localhost:${port}`;
  const apiEndpoint = `${apiUrl}/api/v1/video/jobs/${jobId}/status`;

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
    console.log(`✅ Local DB updated for job ${jobId} to ${status}`);
  } catch (err) {
    console.error(`❌ Local DB update failed for job ${jobId}:`, err.message);
  }

  try {
    // Non-blocking status update to Vercel/Render API
    axios.post(apiEndpoint, data).catch(err => {
        console.error(`❌ API update failed for job ${jobId}:`, err.message);
    });
  } catch (err) {
    // Silently handle sync errors
  }
};

const worker = new Worker('video-processing', async (job) => {
  console.log(`🔔 [Worker] Received job: ${job.id}`);
  console.log(`📦 Job Data:`, JSON.stringify(job.data, null, 2));
  const { jobId, videoUrl, fps, webhookUrl } = job.data;
  const outputDir = path.join(os.tmpdir(), 'videotoimage', jobId);
  const localVideoPath = path.join(os.tmpdir(), `video_${jobId}.mp4`);

  try {
    // 1. Initial status update
    await updateStatus(jobId, { status: 'processing', startedAt: new Date().toISOString() });

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 2. Download video
    console.log(`Downloading video for job ${jobId}...`);
    const writer = fs.createWriteStream(localVideoPath);
    const response = await axios({ url: videoUrl, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // 3. Extract frames
    console.log(`Extracting frames for job ${jobId}...`);
    await new Promise((resolve, reject) => {
      let command = ffmpeg(localVideoPath)
        .on('start', () => console.log('FFmpeg started'))
        .on('end', resolve)
        .on('error', reject);
      if (fps) command.outputOptions(`-vf fps=${fps}`);
      command.output(path.join(outputDir, 'frame_%04d.png')).run();
    });

    // 4. Upload frames
    const frameFiles = fs.readdirSync(outputDir).sort();
    console.log(`Uploading ${frameFiles.length} frames for job ${jobId}...`);
    const uploadedUrls = [];

    for (const file of frameFiles) {
      const filePath = path.join(outputDir, file);
      const fileContent = fs.readFileSync(filePath);
      const r2Key = `temp/${jobId}/${file}`;

      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: r2Key,
        Body: fileContent,
        ContentType: 'image/png',
      }));

      const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;
      uploadedUrls.push(publicUrl);

      // Status update is now non-blocking
      if (uploadedUrls.length % 5 === 0 || uploadedUrls.length === frameFiles.length) {
        updateStatus(jobId, { status: 'processing', frames: uploadedUrls });
      }
    }

    // 5. Final status update
    await updateStatus(jobId, { status: 'previewing', completedAt: new Date().toISOString(), frames: uploadedUrls });
    console.log(`✅ Job ${jobId} ready for preview. Freeing up worker for next job...`);

    // 6. Send Webhook Notification
    if (webhookUrl && webhookUrl.trim() !== "") {
      let finalWebhookUrl = webhookUrl.trim();
      // Auto-prefix http:// if protocol is missing
      if (!finalWebhookUrl.startsWith('http://') && !finalWebhookUrl.startsWith('https://')) {
        finalWebhookUrl = 'http://' + finalWebhookUrl;
      }

      console.log(`🔗 Attempting to send webhook to: ${finalWebhookUrl}`);
      try {
        const frameLinksText = uploadedUrls.map((url, index) => `Frame ${index + 1}: ${url}`).join('\n');
        const payload = {
          text: `🎬 *Video Processed!*\n*Job ID:* ${jobId}\n*Total Frames:* ${uploadedUrls.length}\n*Status:* ✅ Ready for Preview\n\n*Image Links:*\n${frameLinksText}`,
          jobId,
          status: 'previewing',
          frames: uploadedUrls,
          completedAt: new Date().toISOString()
        };
        
        await axios.post(finalWebhookUrl, payload, { 
          timeout: 15000, // Increased timeout for potentially large payload
          headers: { 'Content-Type': 'application/json' }
        });
        console.log(`✅ Webhook delivered successfully for job ${jobId}`);
      } catch (err) {
        console.error(`❌ Webhook failed for job ${jobId}:`);
        console.error(`   - Target URL: ${finalWebhookUrl}`);
        console.error(`   - Error: ${err.message}`);
        if (err.response) {
            console.error(`   - Response Status: ${err.response.status}`);
            console.error(`   - Response Data:`, JSON.stringify(err.response.data));
        }
      }
    }

    // 7. Cleanup (Async background)
    (async () => {
        try {
            if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
            if (fs.existsSync(localVideoPath)) fs.unlinkSync(localVideoPath);
            console.log(`🧹 Cleanup done for job ${jobId}`);
        } catch (e) {
            console.error(`❌ Cleanup failed for job ${jobId}:`, e.message);
        }
    })();

    return { status: 'completed', jobId }; 

  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error.message);
    await updateStatus(jobId, { status: 'failed', failedAt: new Date().toISOString(), error: error.message });

    // Send failure webhook notification
    if (webhookUrl && webhookUrl.trim() !== "") {
      let finalFailureWebhookUrl = webhookUrl.trim();
      // Auto-prefix http:// if protocol is missing
      if (!finalFailureWebhookUrl.startsWith('http://') && !finalFailureWebhookUrl.startsWith('https://')) {
        finalFailureWebhookUrl = 'http://' + finalFailureWebhookUrl;
      }

      console.log(`🔗 Attempting to send failure webhook to: ${finalFailureWebhookUrl}`);
      try {
        const failurePayload = {
          text: `❌ Video Processing Failed!\nJob ID: ${jobId}\n⚠️ Error: ${error.message}`,
          jobId,
          status: 'failed',
          error: error.message,
          failedAt: new Date().toISOString()
        };

        await axios.post(finalFailureWebhookUrl, failurePayload, { 
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        });
        console.log(`✅ Failure webhook delivered successfully for job ${jobId}`);
      } catch (err) {
        console.error(`❌ Failure webhook failed for job ${jobId}:`);
        console.error(`   - Target URL: ${finalFailureWebhookUrl}`);
        console.error(`   - Error: ${err.message}`);
        if (err.response) {
            console.error(`   - Response Status: ${err.response.status}`);
            console.error(`   - Response Data:`, JSON.stringify(err.response.data));
        }
      }
    }

    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    if (fs.existsSync(localVideoPath)) fs.unlinkSync(localVideoPath);
    throw error;
  }
}, { 
  connection: redisUrl || connectionOptions,
  concurrency: 1, 
  lockDuration: 300000, // 5 minutes lock
  stalledInterval: 30000, // Check for stalled jobs every 30s
});

worker.on('ready', () => {
  console.log('✅ Worker is ready and connected to Redis.');
});

worker.on('error', (err) => {
  console.error('❌ Worker connection error:', err.message);
});

worker.on('active', (job) => {
  console.log(`🚀 Job ${job.id} has started.`);
});

worker.on('waiting', (jobId) => {
  console.log(`⏳ Job ${jobId} is waiting in the queue.`);
});

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} has completed!`);
});
worker.on('failed', (job, err) => console.error(`❌ Job ${job.id} failed:`, err.message));

module.exports = worker;
