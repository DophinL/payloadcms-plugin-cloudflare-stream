# Cloudflare Stream Plugin for PayloadCMS

这个插件为PayloadCMS提供了与Cloudflare Stream的集成，让你可以轻松上传和管理视频内容。

## 功能

- ✅ 支持服务端上传视频到Cloudflare Stream
- ✅ 支持客户端直接上传到Cloudflare Stream (clientUploads)
- ✅ 支持更新视频（替换旧视频）
- ✅ 自动跟踪视频处理状态
- ✅ 在删除资源时自动删除Cloudflare Stream视频
- ✅ 支持各种Cloudflare Stream视频选项（水印、下载限制等）

## 安装

```bash
npm install payloadcms-plugin-cloudflare-stream
# 或
yarn add payloadcms-plugin-cloudflare-stream
# 或
pnpm add payloadcms-plugin-cloudflare-stream
```

## 使用方法

在你的Payload配置文件中：

```typescript
import { buildConfig } from 'payload/config'
import { cloudflareStreamPlugin } from 'payloadcms-plugin-cloudflare-stream'

export default buildConfig({
  // ... 其他Payload配置

  plugins: [
    cloudflareStreamPlugin({
      // Cloudflare账户ID，可以从环境变量读取
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      
      // Cloudflare API令牌，可以从环境变量读取
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      
      // 需要使用Cloudflare Stream的集合
      collections: ['videos', 'courses'],
      
      // 启用客户端上传（可选）
      enableClientUploads: true,
      
      // 调试模式（可选）
      debug: process.env.NODE_ENV !== 'production',
      
      // 视频选项（可选）
      videoOptions: {
        allowDownload: false,
        requireSignedURLs: false,
        maxDurationSeconds: 3600, // 最大1小时
        allowedOrigins: ['https://youmind.com', 'https://*.youmind.com'],
      },
      
      // 视频上传后的回调（可选）
      afterUpload: async ({ collection, data, streamId, streamUrl }) => {
        console.log(`视频已上传: ${streamId}`)
      },
      
      // 视频删除前的回调（可选）
      beforeDelete: async ({ collection, doc, streamId }) => {
        console.log(`即将删除视频: ${streamId}`)
      },
    }),
    // ... 其他插件
  ],
})
```

## 字段结构

插件会为指定的集合添加以下字段组：

```typescript
{
  name: 'cloudflareStream',
  type: 'group',
  admin: {
    position: 'sidebar',
  },
  fields: [
    {
      name: 'streamId',
      label: 'Stream ID',
      type: 'text',
      admin: {
        readOnly: true,
      },
    },
    {
      name: 'streamUrl',
      label: 'Stream URL',
      type: 'text',
      admin: {
        readOnly: true,
      },
    },
    {
      name: 'status',
      label: '状态',
      type: 'select',
      options: ['processing', 'ready', 'error'],
      defaultValue: 'processing',
    },
    // ... 更多字段
  ],
}
```

## 客户端上传

如果启用了`enableClientUploads`，你可以在前端直接上传视频到Cloudflare Stream。插件会使用`@payloadcms/plugin-cloud-storage`的机制来处理客户端上传。

## 视频更新

插件支持视频更新，当你更新包含视频的文档时，旧视频会被自动删除，并替换为新上传的视频。

## 环境变量

建议使用环境变量来存储Cloudflare凭证：

```
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

## 许可

MIT 
