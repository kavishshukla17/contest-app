import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const JUDGE0_URL = (process.env.JUDGE0_URL ?? 'http://localhost:2358').replace(/\/$/, '')
const JUDGE_MODE = process.env.JUDGE_MODE ?? 'auto'

export const LANGUAGE_IDS = {
  python: 71,
  cpp: 54,
  java: 62,
  javascript: 63,
}

function normalizeOutput(text) {
  return text.replace(/\r\n/g, '\n').trim()
}

function mapJudge0Status(statusId) {
  if (statusId === 3) return 'accepted'
  if (statusId === 4) return 'wrong_answer'
  if (statusId === 5) return 'time_limit_exceeded'
  if (statusId === 6) return 'compilation_error'
  if (statusId === 11 || statusId === 12) return 'runtime_error'
  return 'internal_error'
}

async function judge0Available() {
  try {
    const res = await fetch(`${JUDGE0_URL}/about`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function submitToJudge0(sourceCode, languageId, stdin, timeLimitSec, memoryLimitKb) {
  const createRes = await fetch(`${JUDGE0_URL}/submissions?base64_encoded=false&wait=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_code: sourceCode,
      language_id: languageId,
      stdin,
      cpu_time_limit: timeLimitSec,
      memory_limit: memoryLimitKb,
    }),
  })

  if (!createRes.ok) {
    throw new Error(`Judge0 create failed: ${createRes.status}`)
  }

  const { token } = await createRes.json()

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 500))
    const pollRes = await fetch(
      `${JUDGE0_URL}/submissions/${token}?base64_encoded=false&fields=stdout,stderr,compile_output,status,time,memory`,
    )
    if (!pollRes.ok) {
      throw new Error(`Judge0 poll failed: ${pollRes.status}`)
    }
    const result = await pollRes.json()
    const statusId = result.status?.id ?? 0
    if (statusId <= 2) continue
    return result
  }

  throw new Error('Judge0 polling timed out')
}

async function runSingleTestJudge0(code, languageId, testCase, testIndex, timeLimitSec, memoryLimitKb) {
  try {
    const result = await submitToJudge0(code, languageId, testCase.input, timeLimitSec, memoryLimitKb)

    if (result.status.id === 6) {
      return {
        testIndex,
        passed: false,
        isHidden: testCase.isHidden,
        verdict: 'compilation_error',
        stderr: result.compile_output ?? result.stderr ?? undefined,
      }
    }

    const verdict = mapJudge0Status(result.status.id)
    if (verdict !== 'accepted' && verdict !== 'wrong_answer') {
      return {
        testIndex,
        passed: false,
        isHidden: testCase.isHidden,
        verdict,
        stderr: result.stderr ?? undefined,
      }
    }

    const stdout = result.stdout ?? ''
    const passed = normalizeOutput(stdout) === normalizeOutput(testCase.expectedOutput)

    return {
      testIndex,
      passed,
      isHidden: testCase.isHidden,
      verdict: passed ? 'accepted' : 'wrong_answer',
      stdout: testCase.isHidden ? undefined : stdout,
      expected: testCase.isHidden ? undefined : testCase.expectedOutput,
    }
  } catch (err) {
    return {
      testIndex,
      passed: false,
      isHidden: testCase.isHidden,
      verdict: 'internal_error',
      stderr: err instanceof Error ? err.message : 'Judge error',
    }
  }
}

/** Local Python runner when Judge0 is unavailable (dev fallback). */
async function runLocalPython(code, stdin, timeoutMs) {
  const file = join(tmpdir(), `contest-${randomUUID()}.py`)
  await writeFile(file, code, 'utf8')
  try {
    return await new Promise((resolve) => {
      const proc = spawn(process.env.PYTHON_BIN || 'python3', [file], { timeout: timeoutMs })
      let stdout = ''
      let stderr = ''
      proc.stdin.write(stdin)
      proc.stdin.end()
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      proc.on('close', (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }))
      proc.on('error', (err) => {
        if (err.code === 'ENOENT' && (process.env.PYTHON_BIN || 'python3') === 'python3') {
          const fallback = spawn('python', [file], { timeout: timeoutMs })
          let out = ''
          let errOut = ''
          fallback.stdin.write(stdin)
          fallback.stdin.end()
          fallback.stdout.on('data', (chunk) => {
            out += chunk.toString()
          })
          fallback.stderr.on('data', (chunk) => {
            errOut += chunk.toString()
          })
          fallback.on('close', (exitCode) => resolve({ stdout: out, stderr: errOut, exitCode: exitCode ?? 1 }))
          fallback.on('error', (e2) => resolve({ stdout: '', stderr: e2.message, exitCode: 1 }))
          return
        }
        resolve({ stdout: '', stderr: err.message, exitCode: 1 })
      })
    })
  } finally {
    await unlink(file).catch(() => {})
  }
}

async function runSingleTestLocal(code, language, testCase, testIndex, timeLimitSec) {
  if (language !== 'python') {
    return {
      testIndex,
      passed: false,
      isHidden: testCase.isHidden,
      verdict: 'internal_error',
      stderr: 'Local fallback supports Python only. Start Judge0 for C++/Java/JS.',
    }
  }

  const { stdout, stderr, exitCode } = await runLocalPython(code, testCase.input, timeLimitSec * 1000)
  if (exitCode !== 0) {
    return {
      testIndex,
      passed: false,
      isHidden: testCase.isHidden,
      verdict: 'runtime_error',
      stderr: stderr || `Exit code ${exitCode}`,
    }
  }

  const passed = normalizeOutput(stdout) === normalizeOutput(testCase.expectedOutput)
  return {
    testIndex,
    passed,
    isHidden: testCase.isHidden,
    verdict: passed ? 'accepted' : 'wrong_answer',
    stdout: testCase.isHidden ? undefined : stdout,
    expected: testCase.isHidden ? undefined : testCase.expectedOutput,
  }
}

export async function runAgainstTests(code, language, testCases, options = {}) {
  const { timeLimitSec = 2, memoryLimitKb = 128000, sampleOnly = false } = options
  const cases = sampleOnly ? testCases.filter((t) => !t.isHidden) : testCases

  if (cases.length === 0) {
    return { verdict: 'internal_error', passedTests: 0, totalTests: 0, testResults: [] }
  }

  const languageId = LANGUAGE_IDS[language]
  if (!languageId) {
    return {
      verdict: 'internal_error',
      passedTests: 0,
      totalTests: cases.length,
      testResults: cases.map((tc, i) => ({
        testIndex: i,
        passed: false,
        isHidden: tc.isHidden,
        verdict: 'internal_error',
        stderr: `Unsupported language: ${language}`,
      })),
    }
  }

  let useJudge0 = JUDGE_MODE === 'judge0'
  if (JUDGE_MODE === 'auto') {
    useJudge0 = await judge0Available()
  }

  const testResults = []
  let maxTimeMs = 0
  let maxMemoryKb = 0

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]
    const result = useJudge0
      ? await runSingleTestJudge0(code, languageId, tc, i, timeLimitSec, memoryLimitKb)
      : await runSingleTestLocal(code, language, tc, i, timeLimitSec)
    testResults.push(result)
    if (!result.passed) break
  }

  const passedTests = testResults.filter((r) => r.passed).length
  const lastResult = testResults[testResults.length - 1]
  const allPassed = passedTests === cases.length
  const verdict = allPassed ? 'accepted' : (lastResult?.verdict ?? 'wrong_answer')

  return {
    verdict,
    passedTests,
    totalTests: cases.length,
    testResults,
    executionTimeMs: maxTimeMs,
    memoryKb: maxMemoryKb,
  }
}

export function buildSumArrayTestCases() {
  return [
    { input: '5\n1 2 3 4 5\n', expectedOutput: '15', isHidden: false },
    { input: '3\n10 20 30\n', expectedOutput: '60', isHidden: false },
    { input: '1\n42\n', expectedOutput: '42', isHidden: true },
    { input: '4\n7 8 9 10\n', expectedOutput: '34', isHidden: true },
    { input: '6\n1 1 1 1 1 1\n', expectedOutput: '6', isHidden: true },
  ]
}

export const PROBLEM_STATEMENT =
  'Read an integer n, then n integers on the next line. Output the sum of those integers.'

export function starterCode(language) {
  const templates = {
    python: `# Read n integers and print their sum
n = int(input())
nums = list(map(int, input().split()))
print(sum(nums))
`,
    cpp: `#include <iostream>
using namespace std;

int main() {
    int n;
    cin >> n;
    long long sum = 0;
    for (int i = 0; i < n; i++) {
        int x;
        cin >> x;
        sum += x;
    }
    cout << sum << endl;
    return 0;
}
`,
    java: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        long sum = 0;
        for (int i = 0; i < n; i++) {
            sum += sc.nextLong();
        }
        System.out.println(sum);
    }
}
`,
    javascript: `const fs = require('fs');
const input = fs.readFileSync(0, 'utf8').trim().split(/\\s+/);
const n = Number(input[0]);
let sum = 0;
for (let i = 1; i <= n; i++) {
  sum += Number(input[i]);
}
console.log(sum);
`,
  }
  return templates[language] ?? templates.python
}
