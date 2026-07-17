import { prisma } from '../db.js'
import { ratingToPoints } from '../scoring.js'

const CF_API = 'https://codeforces.com/api'

/** Codeforces allows at most 1 request per 2 seconds. */
const CF_MIN_INTERVAL_MS = 2100
const LUOGU_GAP_MS = 800

let lastCfRequestAt = 0
let lastLuoguRequestAt = 0
let problemsetCache = null
let problemsetCacheKey = ''
let problemsetCacheAt = 0
const CACHE_TTL_MS = 10 * 60 * 1000

function externalKey(contestId, index) {
  return `${contestId ?? 'na'}-${index}`
}

function problemUrl(contestId, index) {
  if (contestId == null || !index) return null
  return `https://codeforces.com/problemset/problem/${contestId}/${index}`
}

/** Light cleanup of Luogu/CF TeX wrappers for plain-text display. */
export function cleanStatementText(text) {
  if (!text) return ''
  return String(text)
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\\le\b/g, '≤')
    .replace(/\\ge\b/g, '≥')
    .replace(/\\neq\b/g, '≠')
    .replace(/\\times\b/g, '×')
    .replace(/\\cdot\b/g, '·')
    .replace(/\\ldots\b/g, '...')
    .replace(/\\,/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildFallbackStatement(cf) {
  const url = problemUrl(cf.contestId, cf.index)
  const tags = (cf.tags ?? []).join(', ') || 'none'
  const rating = cf.rating != null ? String(cf.rating) : 'unrated'
  return [
    cf.name,
    '',
    `Contest ${cf.contestId ?? 'N/A'} · Index ${cf.index ?? '?'} · Rating ${rating}`,
    `Tags: ${tags}`,
    url ? `Open on Codeforces: ${url}` : null,
    '',
    'Full statement could not be fetched automatically for this problem.',
    'Open the Codeforces link above to read the official statement.',
  ]
    .filter((line) => line != null)
    .join('\n')
}

function composeStatement(title, content, url) {
  const parts = []
  if (title) parts.push(cleanStatementText(title), '')
  if (content.background) {
    parts.push(cleanStatementText(content.background), '')
  }
  if (content.description) {
    parts.push(cleanStatementText(content.description), '')
  }
  if (content.formatI) {
    parts.push('Input', cleanStatementText(content.formatI), '')
  }
  if (content.formatO) {
    parts.push('Output', cleanStatementText(content.formatO), '')
  }
  if (content.hint) {
    parts.push('Note', cleanStatementText(content.hint), '')
  }
  if (url) parts.push(`Source: ${url}`)
  return parts.join('\n').trim()
}

function defaultTestCases() {
  return [
    { input: '5\n1 2 3 4 5\n', expectedOutput: '15\n', isHidden: false, orderIndex: 0 },
    { input: '3\n10 20 30\n', expectedOutput: '60\n', isHidden: false, orderIndex: 1 },
    { input: '1\n42\n', expectedOutput: '42\n', isHidden: true, orderIndex: 2 },
  ]
}

function samplesToTestCases(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null
  return samples.map((pair, orderIndex) => {
    const input = Array.isArray(pair) ? String(pair[0] ?? '') : String(pair?.input ?? '')
    const expectedOutput = Array.isArray(pair) ? String(pair[1] ?? '') : String(pair?.output ?? '')
    return {
      input,
      expectedOutput,
      // First sample visible; extra samples used as hidden tests for submit
      isHidden: orderIndex > 0,
      orderIndex,
    }
  })
}

function isPlaceholderStatement(statement) {
  const s = statement || ''
  return (
    !s.trim() ||
    s.includes('API returns metadata only') ||
    s.includes('Full statement could not be fetched') ||
    s.startsWith('Codeforces problem:')
  )
}

async function respectGap(lastAtRef, gapMs) {
  const now = Date.now()
  const wait = gapMs - (now - lastAtRef.value)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastAtRef.value = Date.now()
}

const cfClock = { value: 0 }
const luoguClock = { value: 0 }

/**
 * Call https://codeforces.com/api/{methodName}
 * Response shape: { status: "OK"|"FAILED", comment?, result? }
 */
export async function callCodeforcesApi(methodName, params = {}) {
  const url = new URL(`${CF_API}/${methodName}`)
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  await respectGap(cfClock, CF_MIN_INTERVAL_MS)

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })

  if (!res.ok) {
    throw new Error(`Codeforces HTTP ${res.status} for ${methodName}`)
  }

  const json = await res.json()
  if (json.status === 'FAILED') {
    throw new Error(json.comment || 'Codeforces API request failed')
  }
  if (json.status !== 'OK') {
    throw new Error('Unexpected Codeforces API response')
  }
  return json.result
}

/**
 * Official CF API is metadata-only. Fetch English statement + samples from Luogu's CF mirror.
 * PID format: CF{contestId}{index} e.g. CF4A, CF1791A
 */
export async function fetchProblemDetails(contestId, index) {
  if (contestId == null || !index) return null
  const pid = `CF${contestId}${String(index).toUpperCase()}`

  await respectGap(luoguClock, LUOGU_GAP_MS)

  const res = await fetch(`https://www.luogu.com.cn/problem/${pid}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  })

  if (!res.ok) return null
  const html = await res.text()
  const match = html.match(
    /<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/,
  )
  if (!match) return null

  let payload
  try {
    payload = JSON.parse(match[1])
  } catch {
    return null
  }

  if (payload.status !== 200 || !payload.data?.problem) return null

  const problem = payload.data.problem
  const content =
    payload.data.translations?.en ||
    problem.content ||
    (problem.contenu?.locale === 'en' ? problem.contenu : null) ||
    problem.contenu

  if (!content?.description) return null

  const url = problemUrl(contestId, index)
  const statement = composeStatement(content.name || problem.name, content, url)
  const testCases = samplesToTestCases(problem.samples)
  const timeLimitMs = problem.limits?.time?.[0] ?? 2000
  const memoryLimitKb = problem.limits?.memory?.[0] ?? 256000

  return {
    title: content.name || problem.name,
    statement,
    testCases,
    timeLimitMs,
    memoryLimitKb,
  }
}

/**
 * problemset.problems — all problems (optional tags filter).
 */
export async function fetchCodeforcesProblems(filters = {}) {
  const tags = filters.tag?.trim() || filters.tags?.trim() || ''
  const cacheKey = tags || '__all__'

  if (
    problemsetCache &&
    problemsetCacheKey === cacheKey &&
    Date.now() - problemsetCacheAt < CACHE_TTL_MS
  ) {
    return filterProblems(problemsetCache, filters)
  }

  const params = {}
  if (tags) params.tags = tags

  const result = await callCodeforcesApi('problemset.problems', params)
  const problems = Array.isArray(result?.problems) ? result.problems : []

  problemsetCache = problems
  problemsetCacheKey = cacheKey
  problemsetCacheAt = Date.now()

  return filterProblems(problems, filters)
}

function filterProblems(problems, filters) {
  const limit = Math.max(1, Math.min(filters.limit ?? 5, 20))
  const matched = problems
    .filter((p) => p?.index != null && p?.name)
    .filter((p) => (filters.minRating != null ? (p.rating ?? 0) >= filters.minRating : true))
    .filter((p) => (filters.maxRating != null ? (p.rating ?? Infinity) <= filters.maxRating : true))
    .filter((p) => {
      if (!filters.tag) return true
      return (p.tags ?? []).includes(filters.tag)
    })

  const rated = matched.filter((p) => p.rating != null)
  const pool = rated.length >= limit ? rated : matched
  return shuffle(pool).slice(0, limit)
}

function shuffle(list) {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

async function resolveDetails(cf) {
  try {
    const details = await fetchProblemDetails(cf.contestId, cf.index)
    if (details?.statement) return details
  } catch {
    // fall through
  }
  return {
    title: cf.name,
    statement: buildFallbackStatement(cf),
    testCases: defaultTestCases(),
    timeLimitMs: 2000,
    memoryLimitKb: 256000,
  }
}

/**
 * Import or reuse cached Codeforces problem with statement + samples when available.
 */
export async function importCodeforcesToBank(cf) {
  const key = externalKey(cf.contestId, cf.index ?? 'A')
  const rating = cf.rating ?? undefined

  const existing = await prisma.problemBank.findUnique({
    where: { externalKey: key },
    include: { testCases: { orderBy: { orderIndex: 'asc' } } },
  })

  if (existing && !isPlaceholderStatement(existing.statement)) {
    return existing
  }

  const details = await resolveDetails(cf)
  const testCases = details.testCases?.length ? details.testCases : defaultTestCases()

  if (existing) {
    await prisma.testCase.deleteMany({ where: { problemBankId: existing.id } })
    return prisma.problemBank.update({
      where: { id: existing.id },
      data: {
        title: details.title || cf.name,
        statement: details.statement,
        rating: rating ?? existing.rating,
        tags: cf.tags ?? existing.tags,
        points: ratingToPoints(rating ?? existing.rating ?? undefined),
        timeLimitMs: details.timeLimitMs,
        memoryLimitKb: details.memoryLimitKb,
        testCases: { create: testCases },
      },
      include: { testCases: { orderBy: { orderIndex: 'asc' } } },
    })
  }

  return prisma.problemBank.create({
    data: {
      cfContestId: cf.contestId ?? null,
      cfIndex: cf.index ?? 'A',
      externalKey: key,
      title: details.title || cf.name,
      statement: details.statement,
      rating: rating ?? null,
      tags: cf.tags ?? [],
      points: ratingToPoints(rating),
      timeLimitMs: details.timeLimitMs,
      memoryLimitKb: details.memoryLimitKb,
      testCases: { create: testCases },
    },
    include: { testCases: { orderBy: { orderIndex: 'asc' } } },
  })
}

export async function attachProblemsToContest(contestId, filters) {
  const cfProblems = await fetchCodeforcesProblems(filters)
  if (cfProblems.length === 0) {
    throw new Error(
      'No Codeforces problems matched those filters. Try a different tag or rating range.',
    )
  }

  const attached = []
  const existingCount = await prisma.contestProblem.count({ where: { contestId } })

  for (let i = 0; i < cfProblems.length; i++) {
    const bank = await importCodeforcesToBank(cfProblems[i])
    const cp = await prisma.contestProblem.upsert({
      where: {
        contestId_problemBankId: { contestId, problemBankId: bank.id },
      },
      create: {
        contestId,
        problemBankId: bank.id,
        orderIndex: existingCount + i,
        points: bank.points,
      },
      update: { points: bank.points },
      include: {
        problemBank: {
          include: {
            testCases: { where: { isHidden: false }, orderBy: { orderIndex: 'asc' } },
          },
        },
      },
    })
    attached.push(cp)
  }

  return attached
}

export function publicProblemView(cp, contestId) {
  const pb = cp.problemBank
  const samples = pb.testCases
  const url = problemUrl(pb.cfContestId, pb.cfIndex)
  return {
    id: pb.id,
    contestProblemId: cp.id,
    contestId,
    platform: 'codeforces',
    externalId: pb.externalKey,
    url: url ?? undefined,
    title: pb.title,
    statement: pb.statement,
    rating: pb.rating ?? undefined,
    tags: Array.isArray(pb.tags) ? pb.tags : [],
    points: cp.points,
    orderIndex: cp.orderIndex,
    sampleInput: samples[0]?.input ?? '',
    sampleOutput: samples[0]?.expectedOutput ?? '',
    sampleCount: samples.length,
  }
}
