const { v4: uuidv4 } = require('uuid');
const { videoProcessingQueue } = require('../config/queue');
const db = require('../config/db');
const r2 = require('../config/r2');
const { CopyObjectCommand, PutObjectCommand, DeleteObjectsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const archiver = require('archiver');
const axios = require('axios');
const { Readable } = require('stream');

const getUploadUrl = async (req, res) => {
  const { fileName, contentType, userId } = req.body;
  const jobId = uuidv4();
  
  if (!fileName || !contentType) {
    return res.status(400).json({ error: 'fileName and contentType are required' });
  }

  console.log(`🔑 Upload URL requested by userId=${userId} for file=${fileName}`);

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
  const userId = req.body ? req.body.userId : null;
  const jobId = req.body && req.body.jobId ? req.body.jobId : uuidv4();

  console.log(`📩 Extract frames request: jobId=${jobId}, userId=${userId}, videoUrl=${videoUrl}, webhookUrl=${webhookUrl}`);

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
    userId,
    videoUrl,
    fps,
    webhookUrl,
    status: 'queued',
    createdAt: new Date().toISOString(),
  };

  // Insert job into the database
  try {
    const stmt = db.prepare('INSERT INTO jobs (jobId, userId, videoUrl, fps, status, createdAt, webhookUrl) VALUES (?, ?, ?, ?, ?, ?, ?)');
    stmt.run(jobData.jobId, jobData.userId, jobData.videoUrl, jobData.fps, jobData.status, jobData.createdAt, jobData.webhookUrl);

    // Add job to the queue
    const job = await videoProcessingQueue.add('process-video', jobData, { jobId: jobData.jobId });
    console.log(`✅ Job ${job.id} successfully added to Redis queue`);
    res.status(202).json({ jobId });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: 'Failed to create or queue job' });
  }
};

const getJobStatus = (req, res) => {
  const { jobId } = req.params;
  const { userId } = req.query;
  try {
    const stmt = db.prepare('SELECT * FROM jobs WHERE jobId = ?');
    const job = stmt.get(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Security: Only owner can see the status
    if (userId && job.userId && job.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
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
  const { userId } = req.query;
  try {
    let stmt;
    let jobs;
    if (userId) {
        stmt = db.prepare('SELECT * FROM jobs WHERE userId = ? ORDER BY createdAt DESC');
        jobs = stmt.all(userId);
    } else {
        stmt = db.prepare('SELECT * FROM jobs ORDER BY createdAt DESC');
        jobs = stmt.all();
    }

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
  const { userId } = req.query;
  try {
    if (userId) {
        const stmt = db.prepare('DELETE FROM jobs WHERE userId = ?');
        stmt.run(userId);
    } else {
        const stmt = db.prepare('DELETE FROM jobs');
        stmt.run();
    }
    res.json({ message: 'Jobs deleted successfully' });
  } catch (error) {
    console.error('Error deleting jobs:', error);
    res.status(500).json({ error: 'Failed to delete jobs' });
  }
};

const cancelJob = async (req, res) => {
  const { jobId } = req.params;
  const { userId } = req.query;
  try {
    // 1. Get job data from DB to find associated files
    const jobStmt = db.prepare('SELECT * FROM jobs WHERE jobId = ?');
    const jobData = jobStmt.get(jobId);

    if (jobData) {
      // Security Check
      if (userId && jobData.userId && jobData.userId !== userId) {
          return res.status(403).json({ error: 'Access denied' });
      }
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
  const { userId } = req.query;
  try {
    const stmt = db.prepare('SELECT * FROM jobs WHERE jobId = ?');
    const job = stmt.get(jobId);

    if (!job || !job.frames) {
      return res.status(404).json({ error: 'Frames not found for this job' });
    }

    // Security Check
    if (userId && job.userId && job.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const frames = JSON.parse(job.frames);

    // Set headers for zip download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=frames-${jobId}.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    
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

const updateJobStatus = (req, res) => {
  const { jobId } = req.params;
  const { status, frames, startedAt, completedAt, failedAt, error } = req.body;

  try {
    const jobCheck = db.prepare('SELECT jobId FROM jobs WHERE jobId = ?').get(jobId);
    if (!jobCheck) {
      return res.status(404).json({ error: 'Job not found' });
    }

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

    // Broadcast the update to all connected WebSocket clients
    const wss = req.app.get('wss');
    if (wss) {
      const updatedJob = db.prepare('SELECT * FROM jobs WHERE jobId = ?').get(jobId);
      if (updatedJob.frames) updatedJob.frames = JSON.parse(updatedJob.frames);
      
      wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(JSON.stringify({ type: 'JOB_UPDATE', payload: updatedJob }));
        }
      });
    }

    res.json({ message: 'Status updated' });
  } catch (err) {
    console.error('Error updating job status:', err);
    res.status(500).json({ error: 'Failed to update job status' });
  }
};

const confirmSaveFrames = async (req, res) => {
  const { jobId } = req.params;
  const { urls, userId } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'No images selected to save' });
  }

  try {
    const jobCheck = db.prepare('SELECT userId FROM jobs WHERE jobId = ?').get(jobId);
    if (!jobCheck) return res.status(404).json({ error: 'Job not found' });
    
    // Security Check
    if (userId && jobCheck.userId && jobCheck.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // 1. Prepare all copy operations
    const copyPromises = urls.map(async (url) => {
      const oldKey = url.replace(`${process.env.R2_PUBLIC_URL}/`, '');
      const newKey = oldKey.replace('temp/', 'permanent/');
      
      try {
        await r2.send(new CopyObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          CopySource: encodeURI(`${process.env.R2_BUCKET_NAME}/${oldKey}`),
          Key: newKey
        }));
        return `${process.env.R2_PUBLIC_URL}/${newKey}`;
      } catch (copyErr) {
        console.error(`Failed to copy ${oldKey}:`, copyErr.message);
        return null; // Skip failed ones
      }
    });

    // 2. Execute all copies in parallel
    const results = await Promise.all(copyPromises);
    const permanentUrls = results.filter(url => url !== null);

    if (permanentUrls.length === 0) {
      return res.status(500).json({ error: 'Failed to save any images to cloud' });
    }

    // 3. Update the DB with permanent URLs
    const query = 'UPDATE jobs SET frames = ?, status = ? WHERE jobId = ?';
    db.prepare(query).run(JSON.stringify(permanentUrls), 'completed', jobId);

    // 4. Cleanup: Delete the entire temp folder for this job and the original video
    const job = db.prepare('SELECT videoUrl FROM jobs WHERE jobId = ?').get(jobId);
    
    // Run cleanup in background to not block the response
    (async () => {
      try {
        // Delete original video if it's in R2
        if (job && job.videoUrl && job.videoUrl.includes(process.env.R2_PUBLIC_URL)) {
          const videoKey = job.videoUrl.replace(`${process.env.R2_PUBLIC_URL}/`, '');
          await r2.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: videoKey
          }));
        }

        // Delete all files in temp/jobId/
        // First list them, then delete
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        const listParams = {
          Bucket: process.env.R2_BUCKET_NAME,
          Prefix: `temp/${jobId}/`
        };
        const listedObjects = await r2.send(new ListObjectsV2Command(listParams));

        if (listedObjects.Contents && listedObjects.Contents.length > 0) {
          const deleteParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Delete: {
              Objects: listedObjects.Contents.map(({ Key }) => ({ Key }))
            }
          };
          await r2.send(new DeleteObjectsCommand(deleteParams));
        }
        console.log(`Cleanup completed for job ${jobId}: Temp files and video deleted.`);
      } catch (cleanupErr) {
        console.error(`Cleanup failed for job ${jobId}:`, cleanupErr.message);
      }
    })();

    res.json({ message: `Successfully saved ${permanentUrls.length} images!`, savedCount: permanentUrls.length });
  } catch (error) {
    console.error('Error in confirmSaveFrames:', error);
    res.status(500).json({ error: error.message || 'Failed to save selected images' });
  }
};

const downloadSelectedFrames = async (req, res) => {
  const { jobId } = req.params;
  const { urls, userId } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Selected URLs are required' });
  }

  try {
    const jobCheck = db.prepare('SELECT userId FROM jobs WHERE jobId = ?').get(jobId);
    if (!jobCheck) return res.status(404).json({ error: 'Job not found' });
    
    // Security Check
    if (userId && jobCheck.userId && jobCheck.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Set headers for zip download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=selected-frames-${jobId}.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Download selected frames in parallel
    const downloadPromises = urls.map(async (url, index) => {
      try {
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream'
        });
        const filename = `selected_frame_${(index + 1).toString().padStart(4, '0')}.png`;
        
        // Use a promise to wait for the archive to fully consume the stream
        return new Promise((resolve, reject) => {
          archive.append(response.data, { name: filename });
          response.data.on('end', resolve);
          response.data.on('error', reject);
        });
      } catch (err) {
        console.error(`Failed to download selected frame from ${url}:`, err.message);
      }
    });

    // Wait for all downloads to be added and processed by the archive
    await Promise.all(downloadPromises);
    await archive.finalize();
  } catch (error) {
    console.error('Error creating selected zip download:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate zip file' });
    }
  }
};

const deleteSelectedFrames = async (req, res) => {
  const { jobId } = req.params;
  const { urls, userId } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'No images selected to delete' });
  }

  try {
    const jobCheck = db.prepare('SELECT userId FROM jobs WHERE jobId = ?').get(jobId);
    if (!jobCheck) return res.status(404).json({ error: 'Job not found' });
    
    // Security Check
    if (userId && jobCheck.userId && jobCheck.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // 1. Delete from R2 in parallel
    const deletePromises = urls.map(async (url) => {
      const key = url.replace(`${process.env.R2_PUBLIC_URL}/`, '');
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key
        }));
        return true;
      } catch (err) {
        console.error(`Failed to delete ${key} from R2:`, err.message);
        return false;
      }
    });

    await Promise.all(deletePromises);

    // 2. Update DB: Get current frames and filter out the deleted ones
    const job = db.prepare('SELECT frames FROM jobs WHERE jobId = ?').get(jobId);
    if (job && job.frames) {
      const currentFrames = JSON.parse(job.frames);
      const updatedFrames = currentFrames.filter(f => !urls.includes(f));
      
      db.prepare('UPDATE jobs SET frames = ? WHERE jobId = ?').run(JSON.stringify(updatedFrames), jobId);
    }

    res.json({ message: `Successfully deleted ${urls.length} images!`, deletedCount: urls.length });
  } catch (error) {
    console.error('Error in deleteSelectedFrames:', error);
    res.status(500).json({ error: 'Failed to delete selected images' });
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
  updateJobStatus,
  downloadSelectedFrames,
  confirmSaveFrames,
  deleteSelectedFrames
};
