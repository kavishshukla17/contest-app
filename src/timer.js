export function formatDuration(totalSeconds) {
  const safe = Math.max(0, totalSeconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

/** Elapsed seconds from opened_at; frozen at solved_at once AC. */
export function problemElapsedSeconds(timing, nowMs) {
  if (timing.solveTimeSeconds != null) return timing.solveTimeSeconds
  if (timing.solvedAt) {
    return Math.floor(
      (new Date(timing.solvedAt).getTime() - new Date(timing.openedAt).getTime()) / 1000,
    )
  }
  return Math.floor((nowMs - new Date(timing.openedAt).getTime()) / 1000)
}

export function timingsFromReport(problems) {
  const map = {}
  for (const p of problems) {
    if (!p.openedAt) continue
    map[p.problemBankId] = {
      openedAt: p.openedAt,
      solvedAt: p.solvedAt ?? null,
      solveTimeSeconds: p.solveTimeSeconds,
      solved: p.solved,
    }
  }
  return map
}
