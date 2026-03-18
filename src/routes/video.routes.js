const express = require('express');
const router = express.Router();
const multer = require('multer');
const videoController = require('../controllers/video.controller');

// Use Memory Storage instead of Disk Storage
const storage = multer.memoryStorage();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/get-upload-url', videoController.getUploadUrl);
router.post('/extract-frames', upload.single('video'), videoController.extractFrames);
router.get('/jobs', videoController.getAllJobs);
router.get('/jobs/:jobId', videoController.getJobStatus);
router.get('/jobs/:jobId/download', videoController.downloadJobFrames);
router.post('/jobs/:jobId/cancel', videoController.cancelJob);
router.delete('/jobs', videoController.deleteAllJobs);

module.exports = router;
