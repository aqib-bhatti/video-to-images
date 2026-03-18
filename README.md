# Video Frame Extraction API

This is a robust Node.js and Express.js application designed to asynchronously extract frames from a video, upload them to a cloud storage service (Cloudflare R2), and notify a client via webhooks upon completion.

It features a clean, modern frontend dashboard built with plain HTML, CSS, and JavaScript for easy interaction.

## ✨ Key Features

- **Asynchronous Processing**: Uses a BullMQ queue with Redis to process videos in the background, ensuring the API remains responsive.
- **Cloud-Native Storage**: Streams video uploads directly to Cloudflare R2 and hosts the extracted frames there, minimizing local server load.
- **Persistent Job Tracking**: Utilizes SQLite to keep a persistent record of all jobs, their statuses, and associated data.
- **Real-time Notifications**: Supports webhooks to notify external systems upon job completion or failure. Also provides live updates on the frontend.
- **Dynamic Frame Extraction**: Allows specifying Frames Per Second (FPS) or defaults to extracting all frames from the video.
- **Efficient & Scalable**: Built with streaming in mind to handle large files with minimal memory usage.
- **Interactive Frontend**: A simple dashboard to upload videos, monitor job progress in real-time, search for specific jobs, and download results as a ZIP file.
- **Automatic Cleanup**: Automatically deletes job data (database records and cloud files) after the results are downloaded.
- **Job Management**: Allows cancelling in-progress jobs, which cleans up all associated data from the backend.

## � Core Concepts: The Power of Streaming

This application is built from the ground up with a **streaming-first** architecture to ensure high performance and minimal resource consumption. Here’s how streaming is leveraged across the system:

1.  **Video Upload (Client → R2)**: Instead of buffering the entire video file in memory, the application streams the upload directly from the client to Cloudflare R2. This is achieved using `@aws-sdk/lib-storage`, allowing for the upload of very large files without consuming significant server RAM.

2.  **Frame Extraction (R2 → FFmpeg)**: The background worker doesn't download the video to the local disk. Instead, FFmpeg is fed the Cloudflare R2 URL directly, and it streams the video content to extract frames. This saves disk space and speeds up the start of the processing job.

3.  **ZIP Download (R2 → Client)**: When a user requests to download all frames, the server initiates a stream. It fetches frames one by one from R2, pipes them into an `archiver` instance (which creates the ZIP file on the fly), and streams the resulting ZIP file directly to the user's browser. This means a ZIP file of any size can be generated without storing it on the server, making the process incredibly memory-efficient.

This end-to-end streaming approach makes the application lightweight, fast, and highly scalable.

## �🚀 Getting Started

### Prerequisites

- Node.js
- npm
- Redis Server (running locally or accessible)
- Cloudflare R2 account and credentials

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd video-frame-api
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Environment Variables

Create a `.env` file in the root of the project and add the following variables with your Cloudflare R2 credentials:

```env
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_BUCKET_NAME=your_r2_bucket_name
R2_PUBLIC_URL=your_r2_public_bucket_url
```

### 4. Run the Application

This will start the server and the background worker.

```bash
npm run dev
```

The server will be running at `http://localhost:3000`.

## 🛠️ API Endpoints

All endpoints are prefixed with `/api/v1/video`.

| Method | Endpoint                  | Description                                      |
|--------|---------------------------|--------------------------------------------------|
| `POST` | `/extract-frames`         | Upload a video to start the frame extraction.    |
| `GET`  | `/jobs`                   | Get a list of all jobs.                          |
| `GET`  | `/jobs/:jobId`            | Get the status and details of a specific job.    |
| `POST` | `/jobs/:jobId/cancel`     | Cancel a pending or processing job.              |
| `GET`  | `/jobs/:jobId/download`   | Download all frames for a completed job as a ZIP.|
| `DELETE`| `/jobs`                  | Delete all job records from the database.        |

### Example `POST /extract-frames` Body (form-data):

- `video`: The video file.
- `fps` (optional): Number of frames to extract per second. Defaults to 1.
- `webhookUrl` (optional): A URL to be notified upon job completion or failure.

## 🖥️ Frontend Dashboard

Navigate to `http://localhost:3000` in your browser to use the interactive dashboard for uploading videos and managing jobs.
