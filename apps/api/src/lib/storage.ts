import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

/** The slice of S3 the app uses; tests substitute an in-memory implementation. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** A short-lived GET URL the browser can open directly. */
  presignGet(key: string, ttlSeconds: number, downloadName: string): Promise<string>;
  ensureBucket(): Promise<void>;
}

/**
 * MinIO/S3. Two clients: one for the internal endpoint (uploads from the worker inside the
 * Docker network) and one whose endpoint is baked into presigned URLs, which must be
 * reachable from the user's browser (e.g. http://localhost:9000).
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly presignClient: S3Client;

  constructor(private readonly bucket: string = env.S3_BUCKET) {
    const base = {
      region: env.S3_REGION,
      forcePathStyle: true, // MinIO
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    };
    this.client = new S3Client({ ...base, endpoint: env.S3_ENDPOINT });
    this.presignClient = new S3Client({ ...base, endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    // PUT of the same key overwrites, so re-running an upload is idempotent.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  presignGet(key: string, ttlSeconds: number, downloadName: string): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${downloadName.replace(/[^\w.-]/g, '_')}"`,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}

export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }

  presignGet(key: string, ttlSeconds: number): Promise<string> {
    return Promise.resolve(`memory://${key}?expires=${ttlSeconds}`);
  }

  ensureBucket(): Promise<void> {
    return Promise.resolve();
  }
}

let storage: ObjectStorage | undefined;

export function setObjectStorage(next: ObjectStorage): void {
  storage = next;
}

export function getObjectStorage(): ObjectStorage {
  storage ??= new S3ObjectStorage();
  return storage;
}
