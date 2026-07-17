import cors from 'cors'
import express from 'express'
import passport from 'passport'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import './auth/passport.js'
import { jwtSecret } from './auth/passport.js'
import { prisma } from './db.js'
import { requireAuth, requireTeacher, getUser } from './middleware/auth.js'
import { attachProblemsToContest, publicProblemView, importCodeforcesToBank } from './services/codeforces.js'
import { buildLeaderboardFromDb } from './services/submissionProcessor.js'
import { getSubmissionQueue } from './queue/submissionQueue.js'
import { processSubmissionJob } from './services/submissionProcessor.js'
import { runAgainstTests, starterCode } from './judge.js'

const app = express()
const port = Number(process.env.PORT ?? 4000)

app.use(cors())
app.use(express.json({ limit: '1mb' }))
app.use(passport.initialize())

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, judge0: process.env.JUDGE0_URL ?? 'http://localhost:2358' })
})

app.get('/api/languages/:lang/starter', (req, res) => {
  res.json({ code: starterCode(req.params.lang) })
})

app.post('/api/auth/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err) return next(err)
    if (!user) return res.status(401).json({ message: info?.message ?? 'Invalid credentials' })
    const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: '12h' })
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
  })(req, res, next)
})

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['teacher', 'student']),
  collegeId: z.string().optional(),
})

app.post('/api/auth/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.flatten())
  const bcrypt = await import('bcryptjs')
  const { name, email, password, role, collegeId } = parsed.data
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (existing) return res.status(409).json({ message: 'Email already exists' })
  const user = await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase(),
      passwordHash: await bcrypt.default.hash(password, 10),
      role,
      collegeId: collegeId ?? null,
    },
  })
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role })
})

app.get('/api/contests', requireAuth, async (req, res) => {
  const user = getUser(req)
  const contests = await prisma.contest.findMany({ orderBy: { startAt: 'desc' } })
  const result = await Promise.all(
    contests.map(async (c) => {
      const problemCount = await prisma.contestProblem.count({ where: { contestId: c.id } })
      const participation = await prisma.participation.findUnique({
        where: { contestId_studentId: { contestId: c.id, studentId: user.id } },
      })
      const lb = user.role === 'student' ? await buildLeaderboardFromDb(c.id) : []
      const myRank = lb.find((r) => r.studentId === user.id)?.rank
      return {
        ...c,
        problemCount,
        joined: Boolean(participation),
        myScore: participation?.score ?? 0,
        myRank,
      }
    }),
  )
  res.json(result)
})

app.post('/api/contests', requireAuth, requireTeacher, async (req, res) => {
  const schema = z.object({
    title: z.string().min(3),
    description: z.string().optional(),
    startAt: z.string(),
    endAt: z.string(),
    durationMinutes: z.number().int().min(30),
    allowedLanguages: z.array(z.string()).min(1),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.flatten())
  const user = getUser(req)
  const contest = await prisma.contest.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      startAt: new Date(parsed.data.startAt),
      endAt: new Date(parsed.data.endAt),
      durationMinutes: parsed.data.durationMinutes,
      allowedLanguages: parsed.data.allowedLanguages,
      createdById: user.id,
      isPublished: true,
    },
  })
  res.status(201).json(contest)
})

app.post('/api/contests/:contestId/problems/import', requireAuth, requireTeacher, async (req, res) => {
  const schema = z.object({
    minRating: z.number().int().optional(),
    maxRating: z.number().int().optional(),
    tag: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(5),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.flatten())
  const { contestId } = req.params
  const contest = await prisma.contest.findUnique({ where: { id: contestId } })
  if (!contest) return res.status(404).json({ message: 'Contest not found' })

  try {
    const attached = await attachProblemsToContest(contestId, parsed.data)
    res.status(201).json(attached.map((cp) => publicProblemView(cp, contestId)))
  } catch (err) {
    res.status(502).json({ message: err instanceof Error ? err.message : 'Codeforces import failed' })
  }
})

/** Re-fetch full statements/samples for problems that only have CF metadata placeholders. */
app.post('/api/contests/:contestId/problems/refresh-statements', requireAuth, requireTeacher, async (req, res) => {
  const { contestId } = req.params
  const contest = await prisma.contest.findUnique({ where: { id: contestId } })
  if (!contest) return res.status(404).json({ message: 'Contest not found' })

  try {
    const cps = await prisma.contestProblem.findMany({
      where: { contestId },
      include: { problemBank: true },
      orderBy: { orderIndex: 'asc' },
    })

    let refreshed = 0
    for (const cp of cps) {
      const pb = cp.problemBank
      const updated = await importCodeforcesToBank({
        contestId: pb.cfContestId ?? undefined,
        index: pb.cfIndex,
        name: pb.title,
        rating: pb.rating ?? undefined,
        tags: Array.isArray(pb.tags) ? pb.tags : [],
      })
      if (updated.statement !== pb.statement) refreshed += 1
    }

    const fresh = await prisma.contestProblem.findMany({
      where: { contestId },
      orderBy: { orderIndex: 'asc' },
      include: {
        problemBank: {
          include: { testCases: { where: { isHidden: false }, orderBy: { orderIndex: 'asc' } } },
        },
      },
    })

    res.json({
      refreshed,
      total: fresh.length,
      problems: fresh.map((cp) => publicProblemView(cp, contestId)),
    })
  } catch (err) {
    res.status(502).json({
      message: err instanceof Error ? err.message : 'Failed to refresh statements',
    })
  }
})

app.get('/api/contests/:contestId/problems', requireAuth, async (req, res) => {
  const { contestId } = req.params
  const cps = await prisma.contestProblem.findMany({
    where: { contestId },
    orderBy: { orderIndex: 'asc' },
    include: {
      problemBank: {
        include: { testCases: { where: { isHidden: false }, orderBy: { orderIndex: 'asc' } } },
      },
    },
  })
  res.json(cps.map((cp) => publicProblemView(cp, contestId)))
})

/** Log opened_at when student clicks a problem — start of solve-time tracking. */
app.post('/api/contests/:contestId/problems/:problemBankId/open', requireAuth, async (req, res) => {
  const user = getUser(req)
  if (user.role !== 'student') return res.status(403).json({ message: 'Students only' })
  const { contestId, problemBankId } = req.params

  const timing = await prisma.questionTiming.upsert({
    where: {
      contestId_problemBankId_studentId: { contestId, problemBankId, studentId: user.id },
    },
    create: { contestId, problemBankId, studentId: user.id, openedAt: new Date() },
    update: {},
  })

  res.json({ openedAt: timing.openedAt, solvedAt: timing.solvedAt })
})

app.post('/api/contests/start', requireAuth, async (req, res) => {
  const user = getUser(req)
  if (user.role !== 'student') return res.status(403).json({ message: 'Students only' })
  const { contestId } = z.object({ contestId: z.string() }).parse(req.body)
  const participation = await prisma.participation.upsert({
    where: { contestId_studentId: { contestId, studentId: user.id } },
    create: { contestId, studentId: user.id },
    update: {},
  })
  res.status(201).json(participation)
})

app.get('/api/contests/:contestId/leaderboard', requireAuth, async (req, res) => {
  const contest = await prisma.contest.findUnique({ where: { id: req.params.contestId } })
  if (!contest) return res.status(404).json({ message: 'Contest not found' })
  res.json({
    contestId: contest.id,
    contestTitle: contest.title,
    rows: await buildLeaderboardFromDb(contest.id),
  })
})

app.post('/api/submissions/run', requireAuth, async (req, res) => {
  const schema = z.object({
    problemBankId: z.string(),
    code: z.string().min(1),
    language: z.string().min(1),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.flatten())

  const problem = await prisma.problemBank.findUnique({
    where: { id: parsed.data.problemBankId },
    include: { testCases: { orderBy: { orderIndex: 'asc' } } },
  })
  if (!problem) return res.status(404).json({ message: 'Problem not found' })

  const testCases = problem.testCases.map((tc) => ({
    input: tc.input,
    expectedOutput: tc.expectedOutput,
    isHidden: tc.isHidden,
  }))

  const result = await runAgainstTests(parsed.data.code, parsed.data.language, testCases, {
    sampleOnly: true,
    timeLimitSec: Math.ceil(problem.timeLimitMs / 1000),
    memoryLimitKb: problem.memoryLimitKb,
  })

  res.json({
    verdict: result.verdict,
    passedTests: result.passedTests,
    totalTests: result.totalTests,
    testResults: result.testResults,
    stdout: result.testResults.at(-1)?.stdout ?? '',
    message:
      result.verdict === 'accepted'
        ? 'All sample tests passed.'
        : `Failed sample test ${result.passedTests + 1} of ${result.totalTests}.`,
  })
})

/** Queue submission for Judge0 sandbox — avoids overloading judge during live contests. */
app.post('/api/submissions', requireAuth, async (req, res) => {
  const user = getUser(req)
  if (user.role !== 'student') return res.status(403).json({ message: 'Students only' })

  const schema = z.object({
    contestId: z.string(),
    problemBankId: z.string(),
    code: z.string().min(1),
    language: z.string().min(1),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.flatten())

  const cp = await prisma.contestProblem.findFirst({
    where: { contestId: parsed.data.contestId, problemBankId: parsed.data.problemBankId },
  })
  if (!cp) return res.status(404).json({ message: 'Problem not in contest' })

  const submission = await prisma.submission.create({
    data: {
      contestId: parsed.data.contestId,
      problemBankId: parsed.data.problemBankId,
      studentId: user.id,
      code: parsed.data.code,
      language: parsed.data.language,
      status: 'queued',
    },
  })

  const syncJudge = process.env.SYNC_JUDGE === 'true' || process.env.SYNC_JUDGE === '1'

  if (syncJudge) {
    await processSubmissionJob(submission.id)
  } else {
    try {
      await getSubmissionQueue().add('judge', { submissionId: submission.id })
    } catch {
      await processSubmissionJob(submission.id)
    }
  }

  const fresh = await prisma.submission.findUnique({ where: { id: submission.id } })
  const isDone = fresh?.status !== 'queued' && fresh?.status !== 'running'

  if (syncJudge || isDone) {
    res.status(201).json({
      id: submission.id,
      status: fresh?.status ?? 'queued',
      message: isDone ? 'Submission judged.' : 'Submission queued for judging.',
    })
    return
  }

  res.status(202).json({
    id: submission.id,
    status: 'queued',
    message: 'Submission queued for judging.',
  })
})

app.get('/api/submissions/:id', requireAuth, async (req, res) => {
  const submission = await prisma.submission.findUnique({ where: { id: req.params.id } })
  if (!submission) return res.status(404).json({ message: 'Not found' })
  const user = getUser(req)
  if (submission.studentId !== user.id && user.role !== 'teacher') {
    return res.status(403).json({ message: 'Forbidden' })
  }

  const participation = await prisma.participation.findUnique({
    where: {
      contestId_studentId: { contestId: submission.contestId, studentId: submission.studentId },
    },
  })
  const lb = await buildLeaderboardFromDb(submission.contestId)

  res.json({
    ...submission,
    totalScore: participation?.score ?? 0,
    rank: lb.find((r) => r.studentId === submission.studentId)?.rank,
  })
})

app.get('/api/contests/:contestId/report', requireAuth, requireTeacher, async (req, res) => {
  const { contestId } = req.params
  const contest = await prisma.contest.findUnique({ where: { id: contestId } })
  if (!contest) return res.status(404).json({ message: 'Contest not found' })

  const contestProblems = await prisma.contestProblem.findMany({
    where: { contestId },
    include: { problemBank: true },
    orderBy: { orderIndex: 'asc' },
  })

  const leaderboard = await buildLeaderboardFromDb(contestId)
  const timings = await prisma.questionTiming.findMany({ where: { contestId } })
  const submissions = await prisma.submission.findMany({ where: { contestId } })

  const rows = leaderboard.map((lb) => {
    const studentTimings = timings.filter((t) => t.studentId === lb.studentId)
    const studentSubs = submissions.filter((s) => s.studentId === lb.studentId)

    const perProblem = contestProblems.map((cp) => {
      const timing = studentTimings.find((t) => t.problemBankId === cp.problemBankId)
      const solveSeconds =
        timing?.openedAt && timing.solvedAt
          ? Math.floor((timing.solvedAt.getTime() - timing.openedAt.getTime()) / 1000)
          : null
      return {
        problemId: cp.problemBankId,
        problemTitle: cp.problemBank.title,
        points: cp.points,
        openedAt: timing?.openedAt ?? null,
        solvedAt: timing?.solvedAt ?? null,
        solveTimeSeconds: solveSeconds,
        solved: Boolean(timing?.solvedAt),
        attempts: studentSubs.filter((s) => s.problemBankId === cp.problemBankId).length,
      }
    })

    return {
      rank: lb.rank,
      studentId: lb.studentId,
      studentName: lb.studentName,
      score: lb.score,
      solvedCount: lb.solvedCount,
      penaltyMinutes: lb.penaltyMinutes,
      totalSolveTimeSeconds: lb.totalTimeSeconds,
      attempts: studentSubs.length,
      perProblem,
    }
  })

  res.json({
    contestId,
    contestTitle: contest.title,
    totalParticipants: rows.length,
    rows,
  })
})

/** Student personal report — per-question solve times from question_timings. */
app.get('/api/contests/:contestId/my-report', requireAuth, async (req, res) => {
  const user = getUser(req)
  const { contestId } = req.params

  const timings = await prisma.questionTiming.findMany({
    where: { contestId, studentId: user.id },
  })
  const cps = await prisma.contestProblem.findMany({
    where: { contestId },
    include: { problemBank: true },
    orderBy: { orderIndex: 'asc' },
  })
  const subs = await prisma.submission.findMany({
    where: { contestId, studentId: user.id },
  })
  const participation = await prisma.participation.findUnique({
    where: { contestId_studentId: { contestId, studentId: user.id } },
  })
  const lb = await buildLeaderboardFromDb(contestId)
  const myRank = lb.find((r) => r.studentId === user.id)

  res.json({
    rank: myRank?.rank,
    score: participation?.score ?? 0,
    problems: cps.map((cp) => {
      const timing = timings.find((t) => t.problemBankId === cp.problemBankId)
      const solveSeconds =
        timing?.openedAt && timing.solvedAt
          ? Math.floor((timing.solvedAt.getTime() - timing.openedAt.getTime()) / 1000)
          : null
      return {
        problemBankId: cp.problemBankId,
        title: cp.problemBank.title,
        points: cp.points,
        openedAt: timing?.openedAt,
        solvedAt: timing?.solvedAt,
        solveTimeSeconds: solveSeconds,
        solved: Boolean(timing?.solvedAt),
        attempts: subs.filter((s) => s.problemBankId === cp.problemBankId).length,
      }
    }),
  })
})

app.listen(port, () => {
  console.log(`API http://localhost:${port}`)
  console.log(`Judge0: ${process.env.JUDGE0_URL ?? 'http://localhost:2358'} | Redis queue enabled`)
})
