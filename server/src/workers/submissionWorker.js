import { Worker } from 'bullmq'
import { redisConnection } from '../queue/submissionQueue.js'
import { processSubmissionJob } from '../services/submissionProcessor.js'

const worker = new Worker(
  'submissions',
  async (job) => {
    const { submissionId } = job.data
    await processSubmissionJob(submissionId)
  },
  {
    connection: redisConnection,
    concurrency: Number(process.env.JUDGE_CONCURRENCY ?? 4),
  },
)

worker.on('completed', (job) => {
  console.log(`Judged submission ${job.data.submissionId}`)
})

worker.on('failed', (job, err) => {
  console.error(`Submission job failed: ${job?.data?.submissionId}`, err.message)
})

console.log('Submission worker started (Judge0 sandbox via queue)')
