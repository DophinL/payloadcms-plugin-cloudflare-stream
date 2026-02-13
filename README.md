# Cloudflare Stream Plugin for PayloadCMS

A powerful plugin that integrates Cloudflare Stream video services with PayloadCMS, providing seamless video uploads, management, and playback capabilities.

[![NPM](https://img.shields.io/npm/v/payloadcms-plugin-cloudflare-stream.svg)](https://www.npmjs.com/package/payloadcms-plugin-cloudflare-stream)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Features

- 🎬 **Video Upload & Management**: Upload videos directly to Cloudflare Stream through PayloadCMS
- 🚀 **Client-Side Uploads**: Support for direct browser-to-Cloudflare uploads using signed URLs
- 📊 **Video Status Tracking**: Automatic monitoring of video processing status
- 🖼️ **Thumbnail Support**: Automatic extraction of video thumbnails from Cloudflare Stream
- 📏 **Video Metadata**: Capture duration, size, and status information
- 🔄 **Status Polling**: Automatic background polling for video processing status
- 🔌 **Cloud Storage Integration**: Built on top of [@payloadcms/plugin-cloud-storage](https://github.com/payloadcms/payload/tree/main/packages/plugin-cloud-storage)

## Installation

```bash
npm install payloadcms-plugin-cloudflare-stream
# or
yarn add payloadcms-plugin-cloudflare-stream
# or
pnpm add payloadcms-plugin-cloudflare-stream
```

## Basic Usage

Add the plugin to your Payload configuration:

```typescript
import { buildConfig } from 'payload/config'
import { cloudflareStreamPlugin } from 'payloadcms-plugin-cloudflare-stream'

export default buildConfig({
  // Your existing Payload config...
  plugins: [
    cloudflareStreamPlugin({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID, // Your Cloudflare account ID
      apiToken: process.env.CLOUDFLARE_API_TOKEN, // Your Cloudflare API token
      streamDomain: process.env.CLOUDFLARE_STREAM_DOMAIN, // e.g., 'https://customer-domain.cloudflarestream.com'
      collections: {
        'media': true, // Enable for media collection
      }
    }),
    // Other plugins...
  ],
})
```

## Configuration Options

The plugin accepts a configuration object with the following options:

```typescript
type CloudflareStreamPluginConfig = {
  /**
   * Collections to apply Cloudflare Stream to
   */
  collections: Partial<Record<UploadCollectionSlug, Omit<CollectionOptions, 'adapter'> | true>>

  /**
   * Cloudflare Account ID
   * Can be read from env var - CLOUDFLARE_ACCOUNT_ID
   */
  accountId?: string

  /**
   * Cloudflare API Token
   * Can be read from env var - CLOUDFLARE_API_TOKEN
   */
  apiToken?: string

  /**
   * Cloudflare Stream domain
   * Used to generate video viewing URLs
   * Example: https://customer-domain.cloudflarestream.com
   */
  streamDomain?: string

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean

  /**
   * Whether the plugin is enabled
   * @default true
   */
  enabled?: boolean

  /**
   * Client uploads configuration
   */
  clientUploads?: ClientUploadsConfig

  /**
   * Callback function after video upload
   */
  afterUpload?: CloudflareStreamPluginOptions['afterUpload']

  /**
   * Callback function before video deletion
   */
  beforeDelete?: CloudflareStreamPluginOptions['beforeDelete']

  /**
   * Custom video processing options
   */
  videoOptions?: CloudflareStreamPluginOptions['videoOptions']

  /**
   * Enable client uploads feature
   * @default false
   */
  enableClientUploads?: boolean

  /**
   * Client-side upload lifecycle callbacks
   */
  clientCallbacks?: ClientUploadCallbacks

  /**
   * Disable local storage
   * @default true
   */
  disableLocalStorage?: boolean
}
```

## Advanced Configuration

### Client-Side Uploads

Enable direct browser-to-Cloudflare uploads for better performance:

```typescript
cloudflareStreamPlugin({
  // Basic config...
  enableClientUploads: true,
  clientUploads: {
    // Optional access control
    access: ({ req }) => true, // Control who can generate upload URLs
  },
})

### Client Upload Callbacks

Hook into the browser upload lifecycle (requires `enableClientUploads: true`):

```typescript
cloudflareStreamPlugin({
  // Basic config...
  enableClientUploads: true,
  clientCallbacks: {
    onProgress: ({ percentage, file }) => {
      toast.loading(`正在上传 ${file.name} (${percentage.toFixed(1)}%)`)
    },
    onSuccess: ({ streamId, uploadType }) => {
      toast.success(`视频 ${streamId} 上传完成，方式：${uploadType}`)
    },
    onError: ({ error, stage }) => {
      toast.error(`上传失败（阶段：${stage}）：${error.message}`)
    },
  },
})
```

The callbacks receive the following payloads:

- `onProgress`: `{ collectionSlug, file, uploadType, bytesUploaded, bytesTotal, percentage }`
- `onSuccess`: `{ collectionSlug, file, uploadType, streamId }`
- `onError`: `{ collectionSlug, file, uploadType, stage: 'generate-upload-url' | 'upload', error }`
```

### Video Options

Configure video processing options:

```typescript
cloudflareStreamPlugin({
  // Basic config...
  videoOptions: {
    requireSignedURLs: false, // Whether videos require signed URLs
    maxDurationSeconds: 3600, // Max video duration (1 hour)
    allowDownload: true, // Allow users to download videos
    allowedOrigins: ['youmind.com', '*.youmind.com'],
    watermark: {
      // Watermark configuration
      uid: 'your-watermark-id',
      size: 0.1,
      position: 'upperRight',
    },
  }
})
```

### Custom Hooks

Add custom logic after upload or before deletion:

```typescript
cloudflareStreamPlugin({
  // Basic config...
  afterUpload: async ({ streamId, streamUrl, collection, data, file, req }) => {
    // Your custom code after upload completes
    console.log(`Video ${streamId} uploaded successfully to ${streamUrl}`)
  },
  beforeDelete: async ({ streamId, collection, doc, req }) => {
    // Your custom code before video deletion
    console.log(`About to delete video ${streamId}`)
  }
})
```

## Video Status Monitoring

The plugin automatically polls Cloudflare's API to monitor video processing status. When a video is uploaded, it initially has a `processing` status. The plugin then polls the API every 5 seconds (up to 20 attempts) until the status changes to either `ready` or `error`.

Once the status changes, the plugin automatically updates the document with:
- Updated status
- Video duration
- Thumbnail URL
- File size

This happens in the background without requiring manual intervention.

## Accessing Videos in Your Application

Videos are stored in the `cloudflareStream` field of your documents:

```typescript
{
  "id": "1234567890",
  "cloudflareStream": {
    "streamId": "cf-stream-id",
    "streamUrl": "https://customer-domain.cloudflarestream.com/cf-stream-id/watch",
    "status": "ready", // 'processing', 'ready', or 'error'
    "uploadedAt": "2023-06-15T12:34:56.789Z",
    "size": 12345678,
    "duration": 120.5, // in seconds
    "thumbnailUrl": "https://customer-domain.cloudflarestream.com/cf-stream-id/thumbnails/thumb.jpg"
  }
}
```

## Requirements

- Node.js: ^18.20.2 || >=20.9.0
- PayloadCMS: ^3.29.0
- @payloadcms/plugin-cloud-storage: ^3.29.0

## License

MIT © [Your Organization]
