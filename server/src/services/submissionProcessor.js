import { prisma } from '../db.js'
import { runAgainstTests } from '../judge.js'
import { ratingToPoints } from '../scoring.js'

const PENALTY_PER_WRONG = 20

export async function processSubmissionJob(submissionId) {
  const submission = await prisma.submission.findUnique({ where: { id: submissionId } })
  if (!submission) throw new Error('Submission not found')

  await prisma.submission.update({
    where: { id: submissionId },
    data: { status: 'running' },
  })

  const problem = await prisma.problemBank.findUnique({
    where: { id: submission.problemBankId },
    include: { testCases: { orderBy: { orderIndex: 'asc' } } },
  })
  if (!problem) throw new Error('Problem not found')

  const testCases = problem.testCases.map((tc) => ({
    input: tc.input,
    expectedOutput: tc.expectedOutput,
    isHidden: tc.isHidden,
  }))

  const timeLimitSec = Math.ceil(problem.timeLimitMs / 1000)
  const result = await runAgainstTests(submission.code, submission.language, testCases, {
    sampleOnly: false,
    timeLimitSec,
    memoryLimitKb: problem.memoryLimitKb,
  })

  const alreadyAccepted = await prisma.submission.findFirst({
    where: {
      contestId: submission.contestId,
      studentId: submission.studentId,
      problemBankId: submission.problemBankId,
      status: 'accepted',
      id: { not: submissionId },
    },
  })

  const cp = await prisma.contestProblem.findFirst({
    where: { contestId: submission.contestId, problemBankId: submission.problemBankId },
  })

  const pointsAwarded =
    result.verdict === 'accepted' && !alreadyAccepted ? (cp?.points ?? problem.points) : 0

  await prisma.submission.update({
    where: { id: submissionId },
    data: {
      status: result.verdict,
      score: pointsAwarded,
      passedTests: result.passedTests,
      totalTests: result.totalTests,
      testResults: result.testResults,
      judgedAt: new Date(),
    },
  })

  if (result.verdict === 'accepted' && !alreadyAccepted) {
    await prisma.questionTiming.updateMany({
      where: {
        contestId: submission.contestId,
        problemBankId: submission.problemBankId,
        studentId: submission.studentId,
        solvedAt: null,
      },
      data: { solvedAt: new Date() },
    })
  }

  await recomputeParticipation(submission.contestId, submission.studentId)
}

export async function recomputeParticipation(contestId, studentId) {
  const subs = await prisma.submission.findMany({
    where: { contestId, studentId },
    orderBy: { createdAt: 'asc' },
  })

  const contestProblems = await prisma.contestProblem.findMany({ where: { contestId } })
  const pointsMap = new Map(contestProblems.map((cp) => [cp.problemBankId, cp.points]))

  const solved = new Set()
  let score = 0
  let penaltyMinutes = 0

  for (const sub of subs) {
    const alreadySolved = solved.has(sub.problemBankId)
    if (sub.status === 'accepted' && !alreadySolved) {
      solved.add(sub.problemBankId)
      score += pointsMap.get(sub.problemBankId) ?? 0
    } else if (
      !alreadySolved &&
      sub.status !== 'queued' &&
      sub.status !== 'running' &&
      sub.status !== 'accepted'
    ) {
      penaltyMinutes += PENALTY_PER_WRONG
    }
  }

  await prisma.participation.upsert({
    where: { contestId_studentId: { contestId, studentId } },
    create: { contestId, studentId, score, penaltyMinutes, solvedCount: solved.size },
    update: { score, penaltyMinutes, solvedCount: solved.size },
  })
}

export async function buildLeaderboardFromDb(contestId) {
  const participations = await prisma.participation.findMany({
    where: { contestId },
    include: { student: true },
  })

  const timings = await prisma.questionTiming.findMany({
    where: { contestId, solvedAt: { not: null } },
  })

  const solveSecondsByStudent = new Map()
  for (const t of timings) {
    if (!t.solvedAt) continue
    const sec = Math.floor((t.solvedAt.getTime() - t.openedAt.getTime()) / 1000)
    solveSecondsByStudent.set(t.studentId, (solveSecondsByStudent.get(t.studentId) ?? 0) + sec)
  }

  const rows = participations
    .map((p) => ({
      studentId: p.studentId,
      studentName: p.student.name,
      score: p.score,
      solvedCount: p.solvedCount,
      penaltyMinutes: p.penaltyMinutes,
      totalTimeSeconds: solveSecondsByStudent.get(p.studentId) ?? 0,
      rank: 0,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.penaltyMinutes !== b.penaltyMinutes) return a.penaltyMinutes - b.penaltyMinutes
      return a.totalTimeSeconds - b.totalTimeSeconds
    })

  rows.forEach((r, i) => {
    r.rank = i + 1
  })
  return rows
}

export { ratingToPoints }
