import { Queue } from 'bullmq'

const redisHost = process.env.REDIS_HOST ?? 'localhost'
const redisPort = Number(process.env.REDIS_PORT ?? 6379)

export const redisConnection = {
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: null,
}

let queue = null

export function getSubmissionQueue() {
  if (!queue) {
    queue = new Queue('submissions', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    })
  }
  return queue
}
