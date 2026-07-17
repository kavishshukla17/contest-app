const PENALTY_PER_WRONG = 20

export function recomputeParticipationScore(
  participation,
  contestId,
  studentId,
  submissions,
  problems,
) {
  const problemMap = new Map(problems.map((p) => [p.id, p.points]))
  const studentSubs = submissions
    .filter((s) => s.contestId === contestId && s.studentId === studentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const solvedProblems = new Set()
  let totalScore = 0
  let penaltyMinutes = 0
  const solvedAt = { ...participation.solvedAt }

  for (const sub of studentSubs) {
    if (sub.status === 'accepted' && !solvedProblems.has(sub.problemId)) {
      solvedProblems.add(sub.problemId)
      totalScore += problemMap.get(sub.problemId) ?? 100
      solvedAt[sub.problemId] = sub.createdAt
    } else if (sub.status !== 'accepted' && !solvedProblems.has(sub.problemId)) {
      penaltyMinutes += PENALTY_PER_WRONG
    }
  }

  participation.score = totalScore
  participation.penaltyMinutes = penaltyMinutes
  participation.solvedCount = solvedProblems.size
  participation.solvedAt = solvedAt
}

export function buildLeaderboard(participations, contestId, users) {
  const rows = participations
    .filter((p) => p.contestId === contestId)
    .map((p) => {
      const user = users.find((u) => u.id === p.studentId)
      const totalTimeSeconds = Object.values(p.perQuestionSeconds).reduce((a, b) => a + b, 0)
      return {
        studentId: p.studentId,
        studentName: user?.name ?? 'Unknown',
        score: p.score,
        solvedCount: p.solvedCount,
        penaltyMinutes: p.penaltyMinutes,
        totalTimeSeconds,
        rank: 0,
      }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.penaltyMinutes !== b.penaltyMinutes) return a.penaltyMinutes - b.penaltyMinutes
      return a.totalTimeSeconds - b.totalTimeSeconds
    })

  rows.forEach((row, index) => {
    row.rank = index + 1
  })

  return rows
}

export function ratingToPoints(rating) {
  if (!rating) return 100
  if (rating < 1200) return 100
  if (rating < 1400) return 200
  if (rating < 1600) return 300
  return 400
}
