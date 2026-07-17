import { useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import {
  createContest,
  getContests,
  getLeaderboard,
  getMyReport,
  getProblems,
  getReport,
  getStarterCode,
  importCodeforcesProblems,
  isUnauthorized,
  login,
  openProblem,
  refreshProblemStatements,
  runSample,
  startContest,
  submitAndWait,
} from './api'
import { formatDuration, problemElapsedSeconds, timingsFromReport } from './timer'

function useLocalSession() {
  const [session, setSession] = useState(() => {
    const raw = localStorage.getItem('contest_session')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed?.token || !parsed?.user?.role) return null
      return parsed
    } catch {
      return null
    }
  })

  useEffect(() => {
    if (session) localStorage.setItem('contest_session', JSON.stringify(session))
    else localStorage.removeItem('contest_session')
  }, [session])

  return { session, setSession }
}

function verdictClass(verdict) {
  if (verdict === 'accepted') return 'verdict-ok'
  if (verdict === 'wrong_answer') return 'verdict-wa'
  return 'verdict-err'
}

function TestResultsTable({ results }) {
  if (results.length === 0) return null
  return (
    <table className="test-table">
      <thead>
        <tr>
          <th>Test</th>
          <th>Result</th>
          <th>Verdict</th>
        </tr>
      </thead>
      <tbody>
        {results.map((tr) => (
          <tr key={tr.testIndex}>
            <td>{tr.isHidden ? `Hidden #${tr.testIndex + 1}` : `Sample #${tr.testIndex + 1}`}</td>
            <td>{tr.passed ? 'Pass' : 'Fail'}</td>
            <td className={verdictClass(tr.verdict)}>{tr.verdict.replace(/_/g, ' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LeaderboardPanel({ rows }) {
  if (rows.length === 0) return <p className="muted">No participants yet.</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Student</th>
          <th>Score</th>
          <th>Solved</th>
          <th>Penalty</th>
          <th>Solve Time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.studentId}>
            <td>#{row.rank}</td>
            <td>{row.studentName}</td>
            <td>{row.score}</td>
            <td>{row.solvedCount}</td>
            <td>{row.penaltyMinutes}m</td>
            <td>{Math.floor(row.totalTimeSeconds / 60)}m {row.totalTimeSeconds % 60}s</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ProblemTimerBadge({ timing, nowMs, active }) {
  if (!timing) return null
  const seconds = problemElapsedSeconds(timing, nowMs)
  const label = timing.solved ? 'Solved in' : active ? 'Timer' : 'Working'
  return (
    <span className={`problem-timer ${timing.solved ? 'solved' : active ? 'active' : 'idle'}`}>
      {label} {formatDuration(seconds)}
    </span>
  )
}

function ActiveProblemTimer({ timing, nowMs, title }) {
  if (!timing) {
    return (
      <div className="active-timer idle">
        <span className="timer-label">Problem timer</span>
        <span className="timer-value">—</span>
        <span className="timer-hint">Open a problem to start the clock</span>
      </div>
    )
  }

  const seconds = problemElapsedSeconds(timing, nowMs)
  return (
    <div className={`active-timer ${timing.solved ? 'solved' : 'running'}`}>
      <span className="timer-label">{timing.solved ? 'Solved in' : 'Time on problem'}</span>
      <span className="timer-value">{formatDuration(seconds)}</span>
      <span className="timer-hint">
        {timing.solved
          ? `${title} — recorded at first AC`
          : `${title} — counting since you opened this problem`}
      </span>
    </div>
  )
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('student@college.edu')
  const [password, setPassword] = useState('student123')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.has('student')) return
    void (async () => {
      try {
        setLoading(true)
        const data = await login('student@college.edu', 'student123')
        onLogin({ token: data.token, user: data.user })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Auto-login failed')
      } finally {
        setLoading(false)
      }
    })()
  }, [onLogin])

  async function handleSubmit(event) {
    event.preventDefault()
    try {
      setLoading(true)
      setError('')
      const data = await login(email, password)
      onLogin({ token: data.token, user: data.user })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel glass">
        <div className="auth-brand-block">
          <div className="auth-brand">Arena</div>
          <div className="brand-tag">Coding Platform</div>
        </div>
        <p className="auth-copy">College coding contests. Clean problems. Fair timing.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button disabled={loading} type="submit">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="hint">Student · <code>student@college.edu</code> / <code>student123</code></p>
        <p className="hint">Teacher · <code>teacher@college.edu</code> / <code>teacher123</code></p>
      </section>
    </main>
  )
}

function TeacherView({ session, onUnauthorized }) {
  const [contests, setContests] = useState([])
  const [selectedContest, setSelectedContest] = useState('')
  const [leaderboard, setLeaderboard] = useState([])
  const [report, setReport] = useState(null)
  const [newContestTitle, setNewContestTitle] = useState('Mid Sem Contest 1')
  const [startAt, setStartAt] = useState(new Date(Date.now() + 3600000).toISOString().slice(0, 16))
  const [endAt, setEndAt] = useState(new Date(Date.now() + 10800000).toISOString().slice(0, 16))
  const [importTag, setImportTag] = useState('implementation')
  const [message, setMessage] = useState('')

  function handleApiError(err, fallback) {
    if (isUnauthorized(err)) {
      onUnauthorized?.()
      return
    }
    setMessage(err instanceof Error ? err.message : fallback)
  }

  async function refreshContests() {
    try {
      const data = await getContests(session.token)
      setContests(data)
      if (!selectedContest && data[0]) setSelectedContest(data[0].id)
    } catch (err) {
      handleApiError(err, 'Could not load contests')
    }
  }

  useEffect(() => {
    void refreshContests()
  }, [])

  async function handleCreateContest(event) {
    event.preventDefault()
    try {
      await createContest(session.token, {
        title: newContestTitle,
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        durationMinutes: 120,
        allowedLanguages: ['cpp', 'java', 'python', 'javascript'],
      })
      setMessage('Contest created.')
      await refreshContests()
    } catch (err) {
      handleApiError(err, 'Unable to create contest')
    }
  }

  async function handleImport() {
    if (!selectedContest) return
    try {
      const imported = await importCodeforcesProblems(session.token, selectedContest, {
        tag: importTag,
        minRating: 1000,
        maxRating: 1800,
        limit: 5,
      })
      setMessage(`Imported ${imported.length} Codeforces problems (with statements when available).`)
      await refreshContests()
    } catch (err) {
      handleApiError(err, 'Import failed')
    }
  }

  async function handleRefreshStatements() {
    if (!selectedContest) return
    try {
      setMessage('Fetching full statements…')
      const result = await refreshProblemStatements(session.token, selectedContest)
      setMessage(`Updated ${result.refreshed} of ${result.total} problem statements.`)
    } catch (err) {
      handleApiError(err, 'Could not refresh statements')
    }
  }

  async function handleLoadReport() {
    if (!selectedContest) return
    try {
      const [reportData, lb] = await Promise.all([
        getReport(session.token, selectedContest),
        getLeaderboard(session.token, selectedContest),
      ])
      setReport(reportData)
      setLeaderboard(lb.rows)
    } catch (err) {
      handleApiError(err, 'Could not load report')
    }
  }

  return (
    <div className="panel-shell">
      <header className="panel-intro">
        <h2>Teacher</h2>
        <p className="lede">Create contests, import Codeforces problems, review results.</p>
      </header>

      <section className="section">
        <div className="section-head">
          <h3>Create contest</h3>
        </div>
        <form className="grid-form" onSubmit={handleCreateContest}>
          <label>Title<input value={newContestTitle} onChange={(e) => setNewContestTitle(e.target.value)} /></label>
          <label>Start<input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} /></label>
          <label>End<input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} /></label>
          <button type="submit">Create</button>
        </form>
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Problems</h3>
        </div>
        <div className="row">
          <select value={selectedContest} onChange={(e) => setSelectedContest(e.target.value)}>
            <option value="">Select contest</option>
            {contests.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <input placeholder="Tag (e.g. implementation)" value={importTag} onChange={(e) => setImportTag(e.target.value)} />
          <button type="button" onClick={() => void handleImport()}>Import</button>
          <button type="button" className="secondary" onClick={() => void handleRefreshStatements()}>
            Refresh statements
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Results</h3>
        </div>
        <div className="row">
          <select value={selectedContest} onChange={(e) => setSelectedContest(e.target.value)}>
            <option value="">Select contest</option>
            {contests.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <button type="button" className="secondary" onClick={() => void handleLoadReport()}>
            Load report
          </button>
        </div>
        {leaderboard.length > 0 && (
          <>
            <h4>Leaderboard</h4>
            <LeaderboardPanel rows={leaderboard} />
          </>
        )}
        {report?.rows.map((row) => (
          <div key={row.studentId} className="report-row">
            <strong>#{row.rank} {row.studentName}</strong>
            <span>Score {row.score} · Penalty {row.penaltyMinutes}m · Solve {row.totalSolveTimeSeconds}s</span>
            <table className="test-table">
              <thead>
                <tr>
                  <th>Problem</th>
                  <th>Opened</th>
                  <th>Solved</th>
                  <th>Solve Time</th>
                  <th>Attempts</th>
                </tr>
              </thead>
              <tbody>
                {row.perProblem.map((pp) => (
                  <tr key={pp.problemId}>
                    <td>{pp.problemTitle}</td>
                    <td>{pp.openedAt ? new Date(pp.openedAt).toLocaleTimeString() : '—'}</td>
                    <td>{pp.solved ? 'Yes' : 'No'}</td>
                    <td>{pp.solveTimeSeconds != null ? `${pp.solveTimeSeconds}s` : '—'}</td>
                    <td>{pp.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {message && <p className="toast ok">{message}</p>}
    </div>
  )
}

function StudentView({ session, onUnauthorized }) {
  const [contests, setContests] = useState([])
  const [contestId, setContestId] = useState('')
  const [problems, setProblems] = useState([])
  const [leaderboard, setLeaderboard] = useState([])
  const [myReport, setMyReport] = useState(null)
  const [activeProblemId, setActiveProblemId] = useState('')
  const [language, setLanguage] = useState('python')
  const [code, setCode] = useState('')
  const [output, setOutput] = useState('')
  const [testResults, setTestResults] = useState([])
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)
  const [problemTimings, setProblemTimings] = useState({})
  const [nowMs, setNowMs] = useState(() => Date.now())

  const [leftTab, setLeftTab] = useState('description')

  function handleApiError(err, fallback) {
    if (isUnauthorized(err)) {
      onUnauthorized?.()
      return
    }
    setStatus(err instanceof Error ? err.message : fallback)
  }

  const activeProblem = useMemo(
    () => problems.find((p) => p.id === activeProblemId) ?? null,
    [activeProblemId, problems],
  )

  async function refresh() {
    try {
      const data = await getContests(session.token)
      setContests(data)
      if (data[0] && !contestId) setContestId(data[0].id)
    } catch (err) {
      handleApiError(err, 'Could not load contests')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!contestId) return
    void getLeaderboard(session.token, contestId).then((lb) => setLeaderboard(lb.rows))
    void refreshTimings()
    const interval = setInterval(() => {
      void getLeaderboard(session.token, contestId).then((lb) => setLeaderboard(lb.rows))
    }, 15000)
    return () => clearInterval(interval)
  }, [contestId, session.token])

  useEffect(() => {
    void getStarterCode(language).then((r) => setCode(r.code))
  }, [language])

  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  async function refreshTimings() {
    if (!contestId) return
    const report = await getMyReport(session.token, contestId)
    setMyReport(report)
    setProblemTimings(timingsFromReport(report.problems))
  }

  async function selectProblem(problemId) {
    setActiveProblemId(problemId)
    setLeftTab('description')
    setTestResults([])
    setOutput('')
    if (contestId) {
      const timing = await openProblem(session.token, contestId, problemId)
      setProblemTimings((prev) => ({
        ...prev,
        [problemId]: {
          openedAt: timing.openedAt,
          solvedAt: timing.solvedAt,
          solveTimeSeconds:
            timing.solvedAt
              ? Math.floor(
                  (new Date(timing.solvedAt).getTime() - new Date(timing.openedAt).getTime()) / 1000,
                )
              : null,
          solved: Boolean(timing.solvedAt),
        },
      }))
    }
  }

  async function joinAndLoad() {
    if (!contestId) return
    await startContest(session.token, contestId)
    const data = await getProblems(session.token, contestId)
    setProblems(data)
    await refreshTimings()
    if (data[0]) await selectProblem(data[0].id)
    setLeftTab('description')
    setStatus('Contest started.')
  }

  async function handleRun() {
    if (!activeProblem) return
    setRunning(true)
    try {
      const response = await runSample(session.token, {
        problemBankId: activeProblem.id,
        code,
        language,
      })
      setOutput(response.stdout)
      setTestResults(response.testResults)
      setStatus(response.message)
    } catch (err) {
      handleApiError(err, 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  async function handleSubmit() {
    if (!activeProblem || !contestId) return
    setRunning(true)
    setStatus('Judging…')
    try {
      const response = await submitAndWait(session.token, {
        contestId,
        problemBankId: activeProblem.id,
        code,
        language,
      })
      setTestResults(response.testResults ?? [])
      setStatus(
        `${response.status.replace(/_/g, ' ').toUpperCase()} — ${response.passedTests}/${response.totalTests} tests. +${response.score} pts. Total: ${response.totalScore}${response.rank ? ` · Rank #${response.rank}` : ''}`,
      )
      const lb = await getLeaderboard(session.token, contestId)
      setLeaderboard(lb.rows)
      await refreshTimings()
    } catch (err) {
      handleApiError(err, 'Submit failed')
    } finally {
      setRunning(false)
    }
  }

  const tabs = [
    { id: 'description', label: 'Description' },
    { id: 'problems', label: 'Problems' },
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'report', label: 'Report' },
  ]

  return (
    <div className="panel-shell contest-shell">
      <div className="contest-toolbar">
        <select value={contestId} onChange={(e) => setContestId(e.target.value)}>
          <option value="">Select contest</option>
          {contests.map((c) => (
            <option key={c.id} value={c.id}>{c.title} ({c.problemCount})</option>
          ))}
        </select>
        <button type="button" onClick={() => void joinAndLoad()}>Start</button>
        {status ? <span className="toolbar-status">{status}</span> : null}
      </div>

      <div className="workspace">
        <aside className="window-pane">
          <nav className="window-tabs" aria-label="Contest panels">
            {tabs.map((tab, i) => (
              <button
                key={tab.id}
                type="button"
                className={`window-tab ${leftTab === tab.id ? 'active' : ''}`}
                onClick={() => setLeftTab(tab.id)}
              >
                {i > 0 ? <span className="tab-divider" aria-hidden="true" /> : null}
                <span className="tab-label">{tab.label}</span>
              </button>
            ))}
          </nav>

          <div className="window-body">
            {leftTab === 'description' && (
              <div className="tab-panel">
                {!activeProblem ? (
                  <p className="muted">Start a contest and open a problem to read the statement.</p>
                ) : (
                  <>
                    <h2 className="problem-title">{activeProblem.title}</h2>
                    <div className="problem-meta">
                      <span>{activeProblem.points} pts</span>
                      <span>CF {activeProblem.externalId}</span>
                      <span>Rating {activeProblem.rating ?? 'N/A'}</span>
                      {activeProblem.url ? (
                        <a href={activeProblem.url} target="_blank" rel="noreferrer">Codeforces</a>
                      ) : null}
                    </div>
                    <p className="statement">{activeProblem.statement}</p>
                    {activeProblem.sampleInput ? (
                      <>
                        <h5>Sample input</h5>
                        <pre>{activeProblem.sampleInput}</pre>
                        <h5>Sample output</h5>
                        <pre>{activeProblem.sampleOutput}</pre>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            )}

            {leftTab === 'problems' && (
              <div className="tab-panel">
                {problems.length === 0 ? (
                  <p className="muted">No problems loaded yet.</p>
                ) : (
                  <ul className="list">
                    {problems.map((problem) => (
                      <li key={problem.id} className={problem.id === activeProblemId ? 'list-active' : ''}>
                        <button className="linkish" onClick={() => void selectProblem(problem.id)} type="button">
                          {problem.title}
                          <span className="muted"> · {problem.points} pts</span>
                        </button>
                        <ProblemTimerBadge
                          timing={problemTimings[problem.id]}
                          nowMs={nowMs}
                          active={problem.id === activeProblemId}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {leftTab === 'leaderboard' && (
              <div className="tab-panel">
                <LeaderboardPanel rows={leaderboard} />
              </div>
            )}

            {leftTab === 'report' && (
              <div className="tab-panel">
                {!myReport ? (
                  <p className="muted">Start the contest to see your report.</p>
                ) : (
                  <>
                    <p className="muted">
                      Rank {myReport.rank ? `#${myReport.rank}` : '—'} · Score {myReport.score}
                    </p>
                    <table className="test-table">
                      <thead>
                        <tr>
                          <th>Problem</th>
                          <th>Solved</th>
                          <th>Solve Time</th>
                          <th>Attempts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {myReport.problems.map((p) => (
                          <tr key={p.problemBankId}>
                            <td>{p.title}</td>
                            <td>{p.solved ? 'Yes' : p.openedAt ? 'In progress' : '—'}</td>
                            <td>
                              {p.solveTimeSeconds != null
                                ? formatDuration(p.solveTimeSeconds)
                                : p.openedAt
                                  ? formatDuration(
                                      problemElapsedSeconds(
                                        {
                                          openedAt: p.openedAt,
                                          solvedAt: p.solvedAt ?? null,
                                          solveTimeSeconds: p.solveTimeSeconds,
                                        },
                                        nowMs,
                                      ),
                                    )
                                  : '—'}
                            </td>
                            <td>{p.attempts}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            )}
          </div>
        </aside>

        <section className="code-pane">
          {activeProblem ? (
            <ActiveProblemTimer
              timing={problemTimings[activeProblem.id]}
              nowMs={nowMs}
              title={activeProblem.title}
            />
          ) : (
            <ActiveProblemTimer timing={undefined} nowMs={nowMs} title="" />
          )}

          <div className="row code-actions">
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="python">Python</option>
              <option value="cpp">C++</option>
              <option value="java">Java</option>
              <option value="javascript">JavaScript</option>
            </select>
            <button type="button" className="secondary" disabled={running} onClick={() => void handleRun()}>
              Run
            </button>
            <button type="button" disabled={running} onClick={() => void handleSubmit()}>
              Submit
            </button>
          </div>

          <div className="editor-wrap editor-fill">
            <Editor
              height="100%"
              language={language === 'cpp' ? 'cpp' : language}
              value={code}
              onChange={(value) => setCode(value ?? '')}
              theme="vs"
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: "'IBM Plex Mono', monospace",
                padding: { top: 12 },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'line',
                automaticLayout: true,
              }}
            />
          </div>

          <div className="io-panel">
            <pre className="io-out">{output || 'Output'}</pre>
            <TestResultsTable results={testResults} />
          </div>
        </section>
      </div>
    </div>
  )
}

export default function App() {
  const { session, setSession } = useLocalSession()

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('student')) return
    void login('student@college.edu', 'student123').then((data) => {
      setSession({ token: data.token, user: data.user })
    })
  }, [setSession])

  useEffect(() => {
    if (!session?.token) return
    void getContests(session.token).catch((err) => {
      if (isUnauthorized(err)) setSession(null)
    })
  }, [session?.token, setSession])

  if (!session) return <LoginScreen onLogin={setSession} />

  return (
    <main className="app-shell">
      <header className="topbar glass">
        <div className="topbar-side" aria-hidden="true" />
        <div className="brand-center">
          <div className="brand">Arena</div>
          <div className="brand-tag">Coding Platform</div>
        </div>
        <div className="topbar-side topbar-user">
          <span className="user-chip">
            {session.user.name}
            <span className="user-role">{session.user.role}</span>
          </span>
          <button type="button" className="ghost" onClick={() => setSession(null)}>
            Sign out
          </button>
        </div>
      </header>
      {session.user.role === 'teacher' ? (
        <TeacherView session={session} onUnauthorized={() => setSession(null)} />
      ) : (
        <StudentView session={session} onUnauthorized={() => setSession(null)} />
      )}
    </main>
  )
}
