# 🎬 Video to Image Converter API (Enterprise Grade)

A high-performance, asynchronous video processing system built with Node.js. This application extracts frames from videos at a specified FPS, stores them in Cloudflare R2, and provides real-time monitoring via a dashboard and Slack-compatible webhooks.

---

## 🏗️ Architecture & Tech Stack

This project is built with a focus on **scalability** and **memory efficiency**:

-   **Backend**: Node.js & Express.js (v5)
-   **Queue Management**: **BullMQ** with **Redis**. Configured for **Sequential Processing** (Concurrency: 1) to prevent server overload.
-   **Video Engine**: **FFmpeg** (fluent-ffmpeg) for frame-accurate extraction.
-   **Storage**: **Cloudflare R2** (S3-Compatible). We use **Streaming Uploads** and **Presigned URLs** to bypass server memory limits.
-   **Database**: **SQLite** (better-sqlite3) for lightweight, persistent job tracking.
-   **Real-time**: **WebSockets (ws)** and polling for instant dashboard updates.
-   **Frontend**: Modern, responsive dashboard (Vanilla JS/CSS).

---



### 2. Direct-to-Cloud Uploads
To handle large 4K videos, we don't upload to the server disk.
- The server generates a **Presigned PUT URL**.
- The browser uploads the video **directly to Cloudflare R2**.
- This makes the system incredibly fast and prevents "Request Entity Too Large" errors.

### 3. Smart Webhooks (Slack Ready)
Integrate with Slack, Discord, or your custom CRM.
- Sends a rich JSON payload.
- Includes a `text` field specifically formatted for **Slack Markdown**.
- **Includes direct public links to every extracted frame** in the message.

### 4. On-the-Fly ZIP Generation
When you click "Download All", the server doesn't store a ZIP file. It **streams** each frame from R2, zips it in memory, and pipes it to your browser simultaneously. Zero disk usage.

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: v18 or higher recommended.
- **Redis**: A running instance (Upstash is highly recommended for production).
- **Cloudflare R2**: A bucket with Public Access enabled.

### 1. Installation
```bash
git clone <your-repo-url>
cd videotoimage
npm install
```

### 2. Configuration (`.env`)
Create a `.env` file in the root:
```env
# Server Config
PORT=3000

# Redis (Format: rediss://default:password@host:port)
REDIS_URL=your_redis_url

# Cloudflare R2 Credentials
R2_ACCOUNT_ID=your_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=your_bucket_name
R2_PUBLIC_URL=https://pub-your-id.r2.dev
```

---

## 🛠️ API Reference

### `POST /api/v1/video/get-upload-url`
Request a presigned URL for R2.
- **Body**: `{ "fileName": "video.mp4", "contentType": "video/mp4" }`
- **Returns**: `{ "uploadUrl": "...", "publicUrl": "...", "jobId": "..." }`

### `POST /api/v1/video/extract-frames`
Queue a video for processing.
- **Body**: `{ "videoUrl": "...", "fps": 5, "webhookUrl": "...", "jobId": "..." }`

### `GET /api/v1/video/jobs`
List all jobs from SQLite database sorted by date.

### `POST /api/v1/video/jobs/:jobId/confirm-save`
Moves "Temporary" extracted frames to a "Permanent" folder in R2 and updates the DB.

---

## 🔗 Webhook Specification

When a job reaches `previewing` or `failed`, a POST request is sent.

**Example Success Payload:**
```json
{
  "text": "🎬 *Video Processed!*\n*Job ID:* e3c190...\n*Total Frames:* 10\n*Status:* ✅ Ready for Preview\n\n*Links:*\nFrame 1: http://...\nFrame 2: http://...",
  "jobId": "e3c190...",
  "status": "previewing",
  "frames": ["url1", "url2"],
  "completedAt": "2026-03-19T..."
}
```

---

## ☁️ Deployment Strategy: Render vs. Vercel

This project is optimized for **Render.com** rather than Vercel. Here’s why:

-   **Serverless Limitations (Vercel)**: Vercel uses Serverless Functions which have a strict execution timeout (usually 10-60 seconds). Video processing with FFmpeg can take minutes, which would cause Vercel functions to kill the process mid-way.
-   **Background Workers**: This app requires a persistent background worker to listen to the Redis queue. Vercel does not support long-running background processes.
-   **Persistent File System**: While we use R2 for storage, FFmpeg needs a temporary local workspace to extract frames before uploading. Render provides a persistent environment, whereas Vercel’s file system is read-only and ephemeral.
-   **WebSockets**: Real-time dashboard updates via WebSockets are natively supported on Render’s persistent instances but are difficult to maintain in a serverless environment like Vercel.

**Recommendation**: Always deploy this on **Render (Web Service)** or a VPS (DigitalOcean/AWS EC2) for stable processing.

---

## ☁️ Deployment Steps (Render)

1.  **Create a Web Service**: Link your GitHub repository to Render.
2.  **Environment Variables**: Set all `.env` variables (Redis, R2, etc.) in the Render dashboard.
3.  **Build Command**: `npm install`
4.  **Start Command**: `npm start` (This starts both the Express server and the BullMQ worker).
5.  **Instance Type**: Ensure you choose an instance with at least 512MB-1GB RAM for FFmpeg stability.

---

## 🛠️ Troubleshooting

- **Redis Connection Error**: If you see `ECONNREFUSED 127.0.0.1`, it means `REDIS_URL` is not being read correctly or the server is falling back to default. Double check your `.env` file.
- **FFmpeg Not Found**: Ensure the `@ffmpeg-installer/ffmpeg` package is installed.
- **Webhook Not Firing**: Ensure your `webhookUrl` is a public URL. Localhost URLs will not work when the app is deployed on Render/Vercel.
