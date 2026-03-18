const { v4: uuidv4 } = require('uuid');
const { videoProcessingQueue } = require('../config/queue');
const db = require('../config/db');
const r2 = require('../config/r2');
const { PutObjectCommand, DeleteObjectsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const archiver = require('archiver');
const axios = require('axios');
const { Readable } = require('stream');

const getUploadUrl = async (req, res) => {
  const { fileName, contentType } = req.body;
  const jobId = uuidv4();
  
  if (!fileName || !contentType) {
    return res.status(400).json({ error: 'fileName and contentType are required' });
  }

  try {
    const sanitizedName = fileName.replace(/[^\x00-\x7F]/g, "").replace(/\s+/g, "_");
    const videoKey = `uploads/${jobId}-${sanitizedName}`;
    
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: videoKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${videoKey}`;

    res.json({ uploadUrl, publicUrl, jobId });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
};

const extractFrames = async (req, res) => {
  let videoUrl = req.body ? req.body.videoUrl : null;
  const fps = req.body ? req.body.fps || 1 : 1;
  const webhookUrl = req.body ? req.body.webhookUrl : null;
  const jobId = req.body && req.body.jobId ? req.body.jobId : uuidv4();

  // If a file was uploaded (old method), stream it directly to R2
  if (req.file) {
    try {
      const videoKey = `uploads/${jobId}-${req.file.originalname}`;
      
      // Convert buffer to stream for true streaming upload
      const stream = Readable.from(req.file.buffer);

      const parallelUploads3 = new Upload({
        client: r2,
        params: {
          Bucket: process.env.R2_BUCKET_NAME,
          Key: videoKey,
          Body: stream,
          ContentType: req.file.mimetype,
        },
      });

      await parallelUploads3.done();
      videoUrl = `${process.env.R2_PUBLIC_URL}/${videoKey}`;
      console.log(`Video streamed to R2: ${videoUrl}`);
    } catch (error) {
      console.error('Failed to stream video to R2:', error);
      return res.status(500).json({ error: 'Failed to upload video to cloud storage' });
    }
  }

  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl or a video file is required' });
  }

  const jobData = {
    jobId,
    videoUrl,
    fps,
    webhookUrl,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  // Insert job into the database
  try {
    const stmt = db.prepare('INSERT INTO jobs (jobId, videoUrl, fps, status, createdAt, webhookUrl) VALUES (?, ?, ?, ?, ?, ?)');
    stmt.run(jobData.jobId, jobData.videoUrl, jobData.fps, jobData.status, jobData.createdAt, jobData.webhookUrl);

    // Add job to the queue
    await videoProcessingQueue.add('process-video', jobData);
    res.status(202).json({ jobId });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: 'Failed to create or queue job' });
  }
};

const getJobStatus = (req, res) => {
  const { jobId } = req.params;
  try {
    const stmt = db.prepare('SELECT * FROM jobs WHERE jobId = ?');
    const job = stmt.get(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Parse frames if they exist
    if (job.frames) {
        job.frames = JSON.parse(job.frames);
    }

    res.json(job);
  } catch (error) {
    console.error('Error fetching job status:', error);
    res.status(500).json({ error: 'Failed to fetch job status' });
  }
};

const getAllJobs = (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM jobs ORDER BY createdAt DESC');
    const jobs = stmt.all();

    // Parse frames for each job
    const formattedJobs = jobs.map(job => {
      if (job.frames) {
        job.frames = JSON.parse(job.frames);
      }
      return job;
    });

    res.json(formattedJobs);
  } catch (error) {
    console.error('Error fetching all jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
};

const deleteAllJobs = (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM jobs');
    stmt.run();
    res.json({ message: 'All jobs deleted successfully' });
  } catch (error) {
    console.error('Error deleting jobs:', error);
    res.status(500).json({ error: 'Failed to delete jobs' });
  }
};

const cancelJob = async (req, res) => {
  const { jobId } = req.params;
  try {
    // 1. Get job data from DB to find associated files
    const jobStmt = db.prepare('SELECT * FROM jobs WHERE jobId = ?');
    const jobData = jobStmt.get(jobId);

    if (jobData) {
      // 2. Delete all associated data (R2 files, DB record)
      await deleteJobData(jobData);
    }

    // 3. Try to remove from BullMQ queue if it exists
    const jobInQueue = await videoProcessingQueue.getJob(jobId);
    if (jobInQueue) {
      await jobInQueue.remove();
    }

    res.json({ message: 'Job cancelled and all data deleted successfully' });
  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
};

const downloadJobFrames = async (req, res) => {
  const { jobId } = req.params;
  try {
    const stmt = db.prepare('SELECT * FROM jobs WHERE jobId = ?');
    const job = stmt.get(jobId);

    if (!job || !job.frames) {
      return res.status(404).json({ error: 'Frames not found for this job' });
    }

    const frames = JSON.parse(job.frames);

    // Set headers for zip download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=frames-${jobId}.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    
    // Listen for when the response finishes
    res.on('finish', async () => {
      console.log(`Download finished for job ${jobId}. Starting auto-deletion...`);
      await deleteJobData(job);
    });

    archive.pipe(res);

    // Download each frame from R2 and add to zip
    for (let i = 0; i < frames.length; i++) {
      const url = frames[i];
      try {
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream'
        });
        const filename = `frame_${(i + 1).toString().padStart(4, '0')}.png`;
        archive.append(response.data, { name: filename });
      } catch (err) {
        console.error(`Failed to download frame from ${url}:`, err.message);
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error creating zip download:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate zip file' });
    }
  }
};

const deleteJobData = async (job) => {
  const { jobId, videoUrl, frames } = job;
  
  try {
    // 1. Delete frames from R2
    if (frames) {
      const frameList = JSON.parse(frames);
      const deleteParams = {
        Bucket: process.env.R2_BUCKET_NAME,
        Delete: {
          Objects: frameList.map(url => ({ Key: url.replace(`${process.env.R2_PUBLIC_URL}/`, '') }))
        }
      };
      await r2.send(new DeleteObjectsCommand(deleteParams));
      console.log(`Deleted ${frameList.length} frames from R2 for job ${jobId}`);
    }

    // 2. Delete video from R2
    if (videoUrl && videoUrl.includes(process.env.R2_PUBLIC_URL)) {
      const videoKey = videoUrl.replace(`${process.env.R2_PUBLIC_URL}/`, '');
      await r2.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: videoKey
      }));
      console.log(`Deleted video from R2 for job ${jobId}`);
    }

    // 3. Delete from SQLite
    const deleteStmt = db.prepare('DELETE FROM jobs WHERE jobId = ?');
    deleteStmt.run(jobId);
    console.log(`Deleted job ${jobId} from database.`);

  } catch (error) {
    console.error(`Failed to delete data for job ${jobId}:`, error);
  }
};

module.exports = {
  getUploadUrl,
  extractFrames,
  getJobStatus,
  getAllJobs,
  deleteAllJobs,
  cancelJob,
  downloadJobFrames,
};
