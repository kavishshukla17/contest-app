const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000/api'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function parseErrorMessage(body, status) {
  if (!body) return `Request failed with status ${status}`
  try {
    const parsed = JSON.parse(body)
    if (parsed?.message) return parsed.message
    if (typeof parsed === 'string') return parsed
  } catch {
    // plain text body
  }
  return body
}

async function call(path, options = {}, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new ApiError(parseErrorMessage(body, response.status), response.status)
  }

  return response.json()
}

export function isUnauthorized(err) {
  return err instanceof ApiError && err.status === 401
}

export async function login(email, password) {
  return call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function getContests(token) {
  return call('/contests', {}, token)
}

export async function createContest(token, payload) {
  return call('/contests', { method: 'POST', body: JSON.stringify(payload) }, token)
}

export async function importCodeforcesProblems(token, contestId, payload) {
  return call(
    `/contests/${contestId}/problems/import`,
    { method: 'POST', body: JSON.stringify(payload) },
    token,
  )
}

export async function refreshProblemStatements(token, contestId) {
  return call(
    `/contests/${contestId}/problems/refresh-statements`,
    { method: 'POST', body: '{}' },
    token,
  )
}

export async function getProblems(token, contestId) {
  return call(`/contests/${contestId}/problems`, {}, token)
}

export async function openProblem(token, contestId, problemBankId) {
  return call(
    `/contests/${contestId}/problems/${problemBankId}/open`,
    { method: 'POST', body: '{}' },
    token,
  )
}

export async function getLeaderboard(token, contestId) {
  return call(`/contests/${contestId}/leaderboard`, {}, token)
}

export async function getStarterCode(language) {
  return call(`/languages/${language}/starter`)
}

export async function startContest(token, contestId) {
  return call(
    '/contests/start',
    { method: 'POST', body: JSON.stringify({ contestId }) },
    token,
  )
}

export async function runSample(token, payload) {
  return call('/submissions/run', { method: 'POST', body: JSON.stringify(payload) }, token)
}

export async function submitSolution(token, payload) {
  return call(
    '/submissions',
    { method: 'POST', body: JSON.stringify(payload) },
    token,
  )
}

export async function getSubmission(token, submissionId) {
  return call(`/submissions/${submissionId}`, {}, token)
}

export async function getReport(token, contestId) {
  return call(`/contests/${contestId}/report`, {}, token)
}

export async function getMyReport(token, contestId) {
  return call(`/contests/${contestId}/my-report`, {}, token)
}

async function pollSubmission(token, submissionId, maxAttempts = 60, intervalMs = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await getSubmission(token, submissionId)
    if (result.status !== 'queued' && result.status !== 'running') {
      return result
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('Judging timed out — check submission status later.')
}

export async function submitAndWait(token, payload) {
  const queued = await submitSolution(token, payload)
  return pollSubmission(token, queued.id)
}
