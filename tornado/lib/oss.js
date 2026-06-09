// 阿里云 OSS 上传
import OSS from "../../node_modules/ali-oss/lib/client.js";
import { OSS_REGION, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_BASE_URL } from "./config.js";

export function getOssClient() {
  return new OSS({
    region: OSS_REGION,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET
  });
}

export async function uploadToOss(buffer, filename, mimeType) {
  const client = getOssClient();
  const opts = mimeType ? { mime: mimeType } : {};
  await client.put(`tornado/${filename}`, buffer, opts);
  return `${OSS_BASE_URL}/tornado/${filename}`;
}
